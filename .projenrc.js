const { GitHubActionTypeScriptProject, RunsUsing } = require('projen-github-action-typescript');
const project = new GitHubActionTypeScriptProject({
  defaultReleaseBranch: 'main',
  devDeps: ['projen-github-action-typescript'],
  name: 'gha-test',

  deps: [
    '@aws-sdk/client-sts',
    '@aws-sdk/signature-v4-multi-region',
    '@aws-sdk/util-create-request',
    '@aws-sdk/util-format-url',
    'axios',
  ],
  actionMetadata: {
    runs: {
      using: RunsUsing.NODE_16,
      main: 'dist/index.js',
    },
    inputs: {
      'aws-region': {
        description: 'The AWS REGION that will be set in the environment',
        default: 'us-east-1',
      },
    },
  },
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();
