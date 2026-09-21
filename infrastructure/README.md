# Glasswaves Infrastructure
## TODO
- [x] Upgrade to CDK V2. [Link](https://docs.aws.amazon.com/cdk/v2/guide/migrating-v2.html)
- [x] Use DNS validation for ACN certificates
  - explore using a * certificate on the root domain
- [ ] Re-add blog.glasswaves.co

## Prequisites
* Github personal access Oath token stored in Secrets Manager in us-west-2

## Development
### Setup
* install `npm install`
* VS Code - `Tasks: Run Build Command` - NPM  Watch - Infrastructure
    * watches files for changes in the background
    * or run the following from the terminal
        * `npm run build`   compile typescript to js
        * `npm run watch`   watch for changes and compile

* `npx cdk <CDK ZCOMMAND>`
    * see below for more commands

### Add a new CDK library
e.g.

```sh
npm install --save @aws-cdk/aws-route53-targets@1.1.0
```

## Using CDk
### List stacks
`npx cdk list`

### Deploying all stacks
`npx cdk deploy`

### Deploy a single stack
`npx cdk deploy glasswaves-co-www`

### Deploy blog stack
`npx cdk deploy glasswaves-co-www-deploy`

### Compare deployed stack with current state
`npx cdk diff`        

### Emit CloudFormation Template
`npx cdk synth`

## Vercel DNS cutover and rollback

`glasswaves-co-www` owns both website DNS records. This stack supports a
`HostingProvider` CloudFormation parameter (`cloudfront` by default, or `vercel`).
In Vercel mode the existing `www` record becomes a CNAME and the apex becomes a
non-alias A record, both with a 300-second TTL. Their logical IDs remain unchanged.
The existing S3 buckets, CloudFront distributions, certificates, and content
pipeline remain available for rollback. DNS does not perform HTTP redirects:
configure the apex-to-www redirect in Vercel.

### Rollout

Merging this change does not deploy infrastructure. Run the following from
`infrastructure/` only after approval to switch production traffic.

1. In Vercel project `glasswaves-dot-co-www`, add `www.glasswaves.co` to Production
   and `glasswaves.co` as a permanent redirect to `https://www.glasswaves.co`.
   Verify the production deployment is the intended content. Check `/index.html`
   compatibility (add a redirect in the website repo if necessary), assets,
   forms, and important existing URLs before cutover.
2. Copy the **actual** apex IPv4 address and www CNAME hostname from Vercel's
   domain settings. Do not copy example values or assume a shared Vercel IP.
   Complete any requested domain ownership validation before proceeding.
3. Authenticate and check the account, then build and test:

   ```sh
   aws sso login --profile glasswaves-legacy
   aws sts get-caller-identity --profile glasswaves-legacy
   # Must show account 081732485147.
   npm ci
   npm test
   ```

4. Review a read-only template diff using the matching CDK CLI version:

   ```sh
   npx aws-cdk@2.59.0 diff glasswaves-co-www --exclusively \
     --profile glasswaves-legacy --no-change-set
   ```

   Expect only the two website DNS resources to change functionally, plus the
   new parameters, condition, and validation rule. CDK metadata may differ.
   Stop on any bucket, distribution, certificate, export, or hosted-zone change.
   Do not deploy all stacks: `glasswaves-co` owns the hosted zone and email;
   `glasswaves-co-www-deploy` owns the legacy content pipeline.
5. Supply the copied values and deploy **only** the website stack:

   ```sh
   read -r VERCEL_APEX_IP
   read -r VERCEL_WWW_CNAME
   npx aws-cdk@2.59.0 deploy glasswaves-co-www --exclusively \
     --profile glasswaves-legacy \
     --parameters HostingProvider=vercel \
     --parameters "VercelApexIp=$VERCEL_APEX_IP" \
     --parameters "VercelWwwCname=$VERCEL_WWW_CNAME"
   ```

   Wait for `UPDATE_COMPLETE`. CloudFormation changes the existing DNS resources;
   do not manually delete either record. DNS caches and Vercel certificate
   issuance can cause a transition window; this is not a zero-downtime guarantee.
6. Verify Vercel reports both domains valid with certificates issued. Check
   `dig A glasswaves.co` and `dig CNAME www.glasswaves.co`, HTTPS on both names,
   HTTP-to-HTTPS behavior, and the apex redirect to www. Check path/query
   preservation, `/index.html`, assets, and forms. Confirm Google MX records
   still match the pre-cutover values. Keep the old hosting through an agreed
   observation period; retiring it is a separate change.

CloudFormation stores the selected parameter values. Subsequent CDK deployments
normally reuse them: omitting `HostingProvider` after cutover does **not** mean
rollback. Always pass the intended provider explicitly when switching traffic.

### Rollback

The previous hosting remains enabled with its original aliases and content.
Switch both records back through the same stack:

```sh
npx aws-cdk@2.59.0 deploy glasswaves-co-www --exclusively \
  --profile glasswaves-legacy --parameters HostingProvider=cloudfront
```

Wait for stack completion and DNS caches (Vercel records have a five-minute TTL),
then verify both names return to CloudFront and the old site/redirect work.
If the stack is in `UPDATE_ROLLBACK_FAILED`, recover CloudFormation first rather
than making conflicting manual DNS edits. Leave Vercel domains configured until
cached traffic has drained. Do not delete the hosted zone or email records.

References: [Vercel DNS setup](https://vercel.com/docs/domains/set-up-custom-domain)
and [CloudFormation RecordSet updates](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-route53-recordset.html).
