import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import core from '@actions/core';
import {
  STSClient,
  AssumeRoleCommand,
  AssumeRoleCommandInput,
  AssumeRoleWithWebIdentityCommand,
  AssumeRoleWithWebIdentityCommandInput,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts';
import { SignatureV4MultiRegion } from '@aws-sdk/signature-v4-multi-region';
import { createRequest } from '@aws-sdk/util-create-request';
import { formatUrl } from '@aws-sdk/util-format-url';
import axios from 'axios';

// The max time that a GitHub action is allowed to run is 6 hours.
// That seems like a reasonable default to use if no role duration is defined.
// const MAX_ACTION_RUNTIME = 6 * 3600;
const DEFAULT_ROLE_DURATION_FOR_OIDC_ROLES = 3600;
const USER_AGENT = 'configure-aws-credentials-for-github-actions';
const MAX_TAG_VALUE_LENGTH = 256;
const SANITIZATION_CHARACTER = '_';
const ROLE_SESSION_NAME = 'GitHubActions';
const REGION_REGEX = /^[a-z0-9-]+$/g;
const LAMBDA_URL = '';

type Environment = {
  GITHUB_REPOSITORY: string;
  GITHUB_WORKFLOW: string;
  GITHUB_ACTION: string;
  GITHUB_ACTOR: string;
  GITHUB_SHA: string;
}

type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function getStsClient(region: string, credentials?: Credentials) {
  return new STSClient({
    region,
    customUserAgent: USER_AGENT,
    credentials,
  });
}

const isDefined: (i: any) => boolean = i => !!i;

let defaultSleep = function (ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
let sleep = defaultSleep;


function sanitizeGithubActor(actor: string) {
  // In some circumstances the actor may contain square brackets. For example, if they're a bot ('[bot]')
  // Square brackets are not allowed in AWS session tags
  return actor.replace(/\[|\]/g, SANITIZATION_CHARACTER);
}

function sanitizeGithubWorkflowName(name: string) {
  // Workflow names can be almost any valid UTF-8 string, but tags are more restrictive.
  // This replaces anything not conforming to the tag restrictions by inverting the regular expression.
  // See the AWS documentation for constraint specifics https://docs.aws.amazon.com/STS/latest/APIReference/API_Tag.html.
  const nameWithoutSpecialCharacters = name.replace(/[^\p{L}\p{Z}\p{N}_:/=+.-@-]/gu, SANITIZATION_CHARACTER);
  const nameTruncated = nameWithoutSpecialCharacters.slice(0, MAX_TAG_VALUE_LENGTH);
  return nameTruncated;
}

function getRoleToAssume() {
  const { GITHUB_REPOSITORY } = process.env as Environment;
  assert(
    isDefined(GITHUB_REPOSITORY),
    'GITHUB_REPOSITORY must be defined.',
  );

  return `arn:aws:iam::<SOME_ACCOUNT>:role/github-${GITHUB_REPOSITORY}`;
}

async function assumeRole(params: any): Promise<Credentials> {

  const {
    sourceAccountId,
    roleToAssume,
    roleExternalId,
    roleDurationSeconds,
    roleSessionName,
    region,
    webIdentityTokenFile,
    webIdentityToken,
  } = params;
  assert(
    [roleToAssume, roleDurationSeconds, roleSessionName, region].every(isDefined),
    'Missing required input when assuming a Role.',
  );

  const { GITHUB_REPOSITORY, GITHUB_WORKFLOW, GITHUB_ACTION, GITHUB_ACTOR, GITHUB_SHA } = process.env as Environment;
  assert(
    [GITHUB_REPOSITORY, GITHUB_WORKFLOW, GITHUB_ACTION, GITHUB_ACTOR, GITHUB_SHA].every(isDefined),
    'Missing required environment value. Are you running in GitHub Actions?',
  );

  const sts = getStsClient(region);

  let roleArn = roleToAssume;
  if (!roleArn.startsWith('arn:aws')) {
    // Supports only 'aws' partition. Customers in other partitions ('aws-cn') will need to provide full ARN
    assert(
      isDefined(sourceAccountId),
      'Source Account ID is needed if the Role Name is provided and not the Role Arn.',
    );
    roleArn = `arn:aws:iam::${sourceAccountId}:role/${roleArn}`;
  }

  const roleSessionTags = [
    { Key: 'GitHub', Value: 'Actions' },
    { Key: 'Repository', Value: GITHUB_REPOSITORY },
    { Key: 'Workflow', Value: sanitizeGithubWorkflowName(GITHUB_WORKFLOW) },
    { Key: 'Action', Value: GITHUB_ACTION },
    { Key: 'Actor', Value: sanitizeGithubActor(GITHUB_ACTOR) },
    { Key: 'Commit', Value: GITHUB_SHA },
  ];

  if (isDefined(process.env.GITHUB_REF)) {
    roleSessionTags.push({ Key: 'Branch', Value: process.env.GITHUB_REF as string });
  }

  core.debug(roleSessionTags.length + ' role session tags are being used.');

  let assumeRoleRequest: AssumeRoleCommandInput | AssumeRoleWithWebIdentityCommandInput = {
    RoleArn: roleArn,
    RoleSessionName: roleSessionName,
    DurationSeconds: roleDurationSeconds,
    Tags: roleSessionTags,
  };

  if (roleExternalId) {
    assumeRoleRequest.ExternalId = roleExternalId;
  }

  let assumeFunction: any = AssumeRoleCommand;
  // These are customizations needed for the GH OIDC Provider
  if (isDefined(webIdentityToken)) {
    delete assumeRoleRequest.Tags;

    Object.assign(assumeRoleRequest, {
      WebIdentityToken: webIdentityToken,
    });

    assumeFunction = AssumeRoleWithWebIdentityCommand;
  } else if (isDefined(webIdentityTokenFile)) {
    core.debug('webIdentityTokenFile provided. Will call sts:AssumeRoleWithWebIdentity and take session tags from token contents.');
    delete assumeRoleRequest.Tags;

    const webIdentityTokenFilePath = path.isAbsolute(webIdentityTokenFile) ?
      webIdentityTokenFile :
      path.join(process.env.GITHUB_WORKSPACE as string, webIdentityTokenFile);

    if (!fs.existsSync(webIdentityTokenFilePath)) {
      throw new Error(`Web identity token file does not exist: ${webIdentityTokenFilePath}`);
    }

    try {
      Object.assign(assumeRoleRequest, {
        WebIdentityToken: await fs.promises.readFile(webIdentityTokenFilePath, 'utf8'),
      });
    } catch (error) {
      throw new Error(`Web identity token file could not be read: ${(error as Error).message}`);
    }
  }

  return sts.send(assumeFunction(assumeRoleRequest))
    .then(({ Credentials: { AccessKeyId, SecretAccessKey, SessionToken } }: any) => {
      return {
        accessKeyId: AccessKeyId,
        secretAccessKey: SecretAccessKey,
        sessionToken: SessionToken,
      };
    });
}

async function retryAndBackoff(fn: () => Promise<any>, isRetryable: boolean, retries = 0, maxRetries = 12, base = 50): Promise<any> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable) {
      throw err;
    }
    // It's retryable, so sleep and retry.
    await sleep(Math.random() * (Math.pow(2, retries) * base) );
    retries += 1;
    if (retries === maxRetries) {
      throw err;
    }
    return await retryAndBackoff(fn, isRetryable, retries, maxRetries, base);
  }
}

function exportCredentials(params: any) {
  // Configure the AWS CLI and AWS SDKs using environment variables and set them as secrets.
  // Setting the credentials as secrets masks them in Github Actions logs
  const { accessKeyId, secretAccessKey, sessionToken } = params;

  // AWS_ACCESS_KEY_ID:
  // Specifies an AWS access key associated with an IAM user or role
  core.setSecret(accessKeyId);
  core.exportVariable('AWS_ACCESS_KEY_ID', accessKeyId);

  // AWS_SECRET_ACCESS_KEY:
  // Specifies the secret key associated with the access key. This is essentially the "password" for the access key.
  core.setSecret(secretAccessKey);
  core.exportVariable('AWS_SECRET_ACCESS_KEY', secretAccessKey);

  // AWS_SESSION_TOKEN:
  // Specifies the session token value that is required if you are using temporary security credentials.
  if (sessionToken) {
    core.setSecret(sessionToken);
    core.exportVariable('AWS_SESSION_TOKEN', sessionToken);
  } else if (process.env.AWS_SESSION_TOKEN) {
    // clear session token from previous credentials action
    core.exportVariable('AWS_SESSION_TOKEN', '');
  }
}

function exportRegion(region: string) {
  core.exportVariable('AWS_DEFAULT_REGION', region);
  core.exportVariable('AWS_REGION', region);
}

async function presignGetCallerIdentity(region: string, roleCredentials: Credentials) {
  const sts = getStsClient(region, roleCredentials);
  const cmd = new GetCallerIdentityCommand({});

  const signer = new SignatureV4MultiRegion({
    service: 'sts',
    ...sts.config,
  });

  const request = await createRequest(sts, cmd);

  request.method = 'GET';
  request.headers = {
    host: request.headers.host,
  };
  request.query = {
    Action: 'GetCallerIdentity',
    Version: '2011-06-15',
  };
  request.body = '';

  const presigned = await signer.presign(request, {
    unsignableHeaders: new Set(['content-type']),
    unhoistableHeaders: new Set(),
  });

  return formatUrl(presigned);
}

async function getCredentials(url: string, accountName: string): Promise<Credentials> {
  const { data } = await axios.post(LAMBDA_URL, {
    url,
    accountName,
  });

  return {
    accessKeyId: data.accessKeyId,
    secretAccessKey: data.secretAccessKey,
    sessionToken: data.sessionToken,
  };
}

async function run() {
  try {
    const region = core.getInput('aws-region', { required: true });
    const audience = core.getInput('audience', { required: false });
    const accountName = core.getInput('account-name', { required: true });
    const roleDurationSeconds = core.getInput('role-duration-seconds', { required: false }) || DEFAULT_ROLE_DURATION_FOR_OIDC_ROLES;
    const roleSessionName = core.getInput('role-session-name', { required: false }) || ROLE_SESSION_NAME;
    const webIdentityTokenFile = core.getInput('web-identity-token-file', { required: false });
    const roleToAssume = getRoleToAssume();

    const webIdentityToken = await core.getIDToken(audience);

    if (!region.match(REGION_REGEX)) {
      throw new Error(`Region is not valid: ${region}`);
    }

    exportRegion(region);

    if (roleToAssume) {
      const initialCredentials = await retryAndBackoff(
        async () => assumeRole({
          region,
          roleToAssume,
          roleDurationSeconds,
          roleSessionName,
          webIdentityTokenFile,
          webIdentityToken,
        }), true);

      const url = await presignGetCallerIdentity(region, initialCredentials);
      const credentials = await getCredentials(url, accountName);

      exportCredentials(credentials);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

run() as Promise<void>;
