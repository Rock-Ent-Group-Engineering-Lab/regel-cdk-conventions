// Offline checks for the AIP naming contract. Runs against the built dist/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { RegelAppInferenceProfile, REGEL_BEDROCK_MODELS } = require('../dist/index.js');

function synth(modelId) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: { account: '859287179937', region: 'us-east-2' } });
  new RegelAppInferenceProfile(stack, 'P', { appSlug: 'probe', modelId });
  return Template.fromStack(stack);
}

test('Opus 5.5 ids are the system inference profile ids', () => {
  assert.equal(REGEL_BEDROCK_MODELS.CLAUDE_OPUS_5_5, 'us.anthropic.claude-opus-5-5');
  assert.equal(REGEL_BEDROCK_MODELS.CLAUDE_OPUS_5_5_GLOBAL, 'global.anthropic.claude-opus-5-5');
});

test('Opus 5.5 shortens to claude-opus-5-5 in the AIP name and SSM path', () => {
  const t = synth(REGEL_BEDROCK_MODELS.CLAUDE_OPUS_5_5);
  t.hasResourceProperties('AWS::Bedrock::ApplicationInferenceProfile', {
    InferenceProfileName: 'probe-claude-opus-5-5',
    ModelSource: { CopyFrom: 'arn:aws:bedrock:us-east-2:859287179937:inference-profile/us.anthropic.claude-opus-5-5' },
  });
  t.hasResourceProperties('AWS::SSM::Parameter', { Name: '/regel-core/probe/bedrock-aip/claude-opus-5-5' });
});

test('global Opus 5.5 gets the -global suffix', () => {
  const t = synth(REGEL_BEDROCK_MODELS.CLAUDE_OPUS_5_5_GLOBAL);
  t.hasResourceProperties('AWS::Bedrock::ApplicationInferenceProfile', {
    InferenceProfileName: 'probe-claude-opus-5-5-global',
  });
});
