const assert = require('node:assert/strict');
const { test } = require('node:test');
const { App } = require('aws-cdk-lib');
const { BaseStack } = require('../lib/base-stack');
const { StaticWebsiteStack } = require('../lib/static-website-stack');
const app = new App();
const base = new BaseStack(app, 'glasswaves-co');
new StaticWebsiteStack(app, 'glasswaves-co-www', {
  domain: 'glasswaves.co', subdomain: 'www', redirectFromRoot: true,
  hostedZone: base.hostedZone, subdomainCertificate: base.wildcardCert,
  domainCertificate: base.nakedCert, logBucket: base.logBucket
});
const template = app.synth().getStackArtifact('glasswaves-co-www').template;
const absent = Symbol('AWS::NoValue');
function resolve(value, vercel) {
  if (Array.isArray(value)) return value.map(v => resolve(v, vercel));
  if (!value || typeof value !== 'object') return value;
  if (value['Fn::If']) return resolve(value['Fn::If'][vercel ? 1 : 2], vercel);
  if (value.Ref === 'AWS::NoValue') return absent;
  if (value.Ref === 'VercelApexIp') return '192.0.2.1';
  if (value.Ref === 'VercelWwwCname') return 'example.vercel-dns-017.com';
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,resolve(v,vercel)]).filter(([,v]) => v !== absent));
}
test('cutover and rollback preserve DNS ownership and valid record shapes', () => {
  const records = [
    ['SubdomainRecordSet04539BA4', 'www.glasswaves.co.', 'CNAME', 'example.vercel-dns-017.com', 'SubdomainDistributionCFDistributionC530BCE6'],
    ['RootRecordSetE29C2033', 'glasswaves.co.', 'A', '192.0.2.1', 'RootDistributionCFDistribution7F48CF95']
  ];
  for (const [id, name, type, target, distribution] of records) {
    const properties = template.Resources[id].Properties;
    const legacy = resolve(properties, false), vercel = resolve(properties, true);
    assert.equal(legacy.Name, name);
    assert.equal(legacy.Type, 'A');
    assert.deepEqual(legacy.AliasTarget.DNSName, { 'Fn::GetAtt': [distribution, 'DomainName'] });
    assert.ok(legacy.AliasTarget.HostedZoneId);
    assert.equal(legacy.TTL, undefined);
    assert.equal(legacy.ResourceRecords, undefined);
    assert.deepEqual(vercel, {Name:name, Type:type, HostedZoneId:legacy.HostedZoneId, ResourceRecords:[target], TTL:'300'});
  }
});
test('legacy is the default and Vercel requires both target values', () => {
  assert.equal(template.Parameters.HostingProvider.Default, 'cloudfront');
  assert.deepEqual(template.Conditions.UseVercel, {'Fn::Equals':[{Ref:'HostingProvider'},'vercel']});
  const rule = template.Rules.RequireVercelTargets;
  assert.deepEqual(rule.RuleCondition, template.Conditions.UseVercel);
  assert.deepEqual(rule.Assertions.map(a => a.Assert), ['VercelApexIp','VercelWwwCname'].map(name => ({'Fn::Not':[{'Fn::Equals':[{Ref:name},'']}]})));
  const ip = new RegExp(template.Parameters.VercelApexIp.AllowedPattern);
  assert.ok(ip.test('192.0.2.1'));
  assert.ok(!ip.test('999.1.1.1'));
  const host = new RegExp(template.Parameters.VercelWwwCname.AllowedPattern);
  assert.ok(host.test('example.vercel-dns-017.com'));
  assert.ok(!host.test('https://example.com/path'));
});
test('both legacy distributions and buckets remain for rollback', () => {
  for (const type of ['AWS::CloudFront::Distribution','AWS::S3::Bucket']) {
    assert.equal(Object.values(template.Resources).filter(r => r.Type === type).length, 2);
  }
});
