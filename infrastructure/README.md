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

## Vercel cutover

The website DNS records point to Vercel's assigned targets: apex A `216.150.1.1`
and www CNAME `52acc4c59db427de.vercel-dns-016.com`. Before deploying, add both domains to
Vercel project `glasswaves-dot-co-www`, assign www to Production, and configure
`glasswaves.co` to permanently redirect to `https://www.glasswaves.co`.
Compare these targets with Vercel's domain settings; if it recommends different
project-specific values, update the two literals in `static-website-stack.ts`
before deployment. Check the new site's content and `/index.html` compatibility.

From this directory, after approval to cut over:

```sh
aws sso login --profile glasswaves-legacy
aws sts get-caller-identity --profile glasswaves-legacy # account 081732485147
npm ci
npm run build
npx aws-cdk@2.59.0 diff glasswaves-co-www --exclusively --profile glasswaves-legacy --no-change-set
npx aws-cdk@2.59.0 deploy glasswaves-co-www --exclusively --profile glasswaves-legacy
```

Expect only the two DNS records to change. Do not deploy all stacks. After the
stack completes, verify Vercel domain/certificate readiness, HTTPS on www, the
apex redirect (including paths and queries), and important old URLs. A brief
outage during DNS/TLS transition is acceptable. Merging alone does not deploy.

Rollback: revert the cutover commit (or squash merge), rebuild, and run the same
CDK deployment. Allow for the five-minute DNS TTL. The existing AWS hosting stays
in place so reverting restores its DNS targets. Hosting cleanup is separate;
the hosted zone and email records remain unchanged.
