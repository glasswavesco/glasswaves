import { App, Aws, CfnCondition, CfnParameter, CfnRule, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_cloudfront as cloudfront } from 'aws-cdk-lib';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { OriginProtocolPolicy, ViewerCertificate, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { ARecord, CfnRecordSet, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';

interface StaticWebsiteStackProps extends StackProps {
  domain: string; // e.g. glasswaves.co
  subdomain: string; // e.g. www
  hostedZone: HostedZone;
  subdomainCertificate: ICertificate;
  logBucket: s3.Bucket
  redirectFromRoot?: boolean;
  domainCertificate?: ICertificate;
}

// WwwStack is an opionated stack for static websites.
export class StaticWebsiteStack extends Stack {
  public readonly subdomainBucket: s3.Bucket
  public readonly subdomainDistribution: cloudfront.CloudFrontWebDistribution

  constructor(parent: App, name: string, props: StaticWebsiteStackProps) {
    super(parent, name, props);

    this.subdomainBucket = this.createSubdomainBucket(props.subdomain, props.domain, props.logBucket)

    this.subdomainDistribution = this.createSubdomainCloudFrontDist(
      this.subdomainBucket,
      props.logBucket,
      props.subdomainCertificate,
      props.subdomain,
      props.domain
    )

    const subdomainRecord = new ARecord(this, 'SubdomainRecordSet', {
      zone: props.hostedZone,
      recordName: `${props.subdomain}.${props.domain}.`,
      target: RecordTarget.fromAlias(
        new CloudFrontTarget(this.subdomainDistribution)
      )
    })

    const hostingProvider = new CfnParameter(this, 'HostingProvider', {
      type: 'String', default: 'cloudfront', allowedValues: ['cloudfront', 'vercel'],
      description: 'DNS destination. Keep cloudfront until Vercel domains and redirects are configured.'
    })
    const vercelApexIp = new CfnParameter(this, 'VercelApexIp', {
      type: 'String', default: '',
      allowedPattern: '^$|^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$',
      description: 'Exact IPv4 address from the Vercel apex domain settings.'
    })
    const vercelWwwCname = new CfnParameter(this, 'VercelWwwCname', {
      type: 'String', default: '',
      allowedPattern: '^$|^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+\\.?$',
      description: 'Exact CNAME hostname from the Vercel www domain settings (no scheme or path).'
    })
    const useVercel = new CfnCondition(this, 'UseVercel', {
      expression: Fn.conditionEquals(hostingProvider.valueAsString, 'vercel')
    })
    new CfnRule(this, 'RequireVercelTargets', {
      ruleCondition: Fn.conditionEquals(hostingProvider.valueAsString, 'vercel'),
      assertions: [vercelApexIp, vercelWwwCname].map(parameter => ({
        assert: Fn.conditionNot(Fn.conditionEquals(parameter.valueAsString, '')),
        assertDescription: `${parameter.logicalId} must be supplied when HostingProvider is vercel.`
      }))
    })

    // Keep construct paths/logical IDs stable: update existing DNS records in place.
    // Hosting resources and cross-stack exports remain available for rollback.
    const configureVercelRecord = (record: ARecord, type: string, value: string) => {
      const resource = record.node.defaultChild as CfnRecordSet
      resource.addPropertyOverride('Type', Fn.conditionIf(useVercel.logicalId, type, 'A'))
      const alias = resource.aliasTarget as CfnRecordSet.AliasTargetProperty
      resource.addPropertyOverride('AliasTarget', Fn.conditionIf(
        useVercel.logicalId, Aws.NO_VALUE, {
          DNSName: alias.dnsName, HostedZoneId: alias.hostedZoneId
        }
      ))
      resource.addPropertyOverride('TTL', Fn.conditionIf(useVercel.logicalId, '300', Aws.NO_VALUE))
      resource.addPropertyOverride('ResourceRecords', Fn.conditionIf(
        useVercel.logicalId, [value], Aws.NO_VALUE
      ))
    }
    configureVercelRecord(subdomainRecord, 'CNAME', vercelWwwCname.valueAsString)

    if (props.redirectFromRoot && props.domainCertificate) {
      const rootBucket = this.createRootBucket(props.subdomain, props.domain, props.logBucket)
      const rootDist = this.createRootCloudFrontDist(rootBucket, props.domain, props.logBucket, props.domainCertificate)
      const rootRecord = new ARecord(this, "RootRecordSet", {
        zone: props.hostedZone,
        recordName: `${props.domain}.`,
        target: RecordTarget.fromAlias(
          new CloudFrontTarget(rootDist)
        )
      })
      configureVercelRecord(rootRecord, 'A', vercelApexIp.valueAsString)
    }
  }

  // Create a Subdomain bucket that hosts some resources
  private createSubdomainBucket(subdomain: string, domain: string, logBucket: s3.Bucket): s3.Bucket {
    let bucket = new s3.Bucket(this, `SubdomainBucket`)
    bucket.grantPublicAccess()

    let cfnBucket = bucket.node.defaultChild as s3.CfnBucket
    cfnBucket.websiteConfiguration = {
      indexDocument: "index.html",
      errorDocument: "404.html"
    };

    cfnBucket.loggingConfiguration = {
      destinationBucketName: logBucket.bucketName,
      logFilePrefix: `bucket-access/${subdomain}.${domain}/`
    };

    return bucket
  }

  // create a root bucket that serves as a redirect bucket to subdomain.domain
  private createRootBucket(subdomain: string, domain: string, logBucket: s3.Bucket): s3.Bucket {
    let bucket = new s3.Bucket(this, "RootBucket");
    bucket.grantPublicAccess()

    let cfnBucket = bucket.node.defaultChild as s3.CfnBucket
    cfnBucket.websiteConfiguration = {
      redirectAllRequestsTo: {
        hostName: `${subdomain}.${domain}`,
        protocol: "https"
      }
    }

    cfnBucket.loggingConfiguration = {
      destinationBucketName: logBucket.bucketName,
      logFilePrefix: `bucket-access/${domain}/`
    }

    return bucket
  }

  private createSubdomainCloudFrontDist(source: s3.Bucket, logBucket: s3.Bucket, certificate: ICertificate, subdomain?: string, domain?: string): cloudfront.CloudFrontWebDistribution {
    return new cloudfront.CloudFrontWebDistribution(this, 'SubdomainDistribution', {
      comment: "Distribution pointing to the subdomain bucket",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      viewerCertificate: cloudfront.ViewerCertificate.fromAcmCertificate(
        certificate,
        { aliases: [`${subdomain}.${domain}`] }
      ),
      errorConfigurations: [
        {
          errorCode: 404,
          responseCode: 404,
          responsePagePath: "/404.html",
          errorCachingMinTtl: 30
        },
        {
          errorCode: 403,
          responseCode: 404,
          responsePagePath: "/404.html",
          errorCachingMinTtl: 30
        }
      ],
      originConfigs: [
        {
          customOriginSource: {
            domainName: source.bucketWebsiteDomainName,
            originProtocolPolicy: OriginProtocolPolicy.HTTP_ONLY
          },
          behaviors: [
            {
              isDefaultBehavior: true,
              compress: true
            }
          ]
        },
      ],
      loggingConfig: {
        bucket: logBucket,
        prefix: `cloudfront/${subdomain}.${domain}/`
      }
    });
  }

  private createRootCloudFrontDist(source: s3.Bucket, domain: string, logBucket: s3.Bucket, certificate: ICertificate): cloudfront.CloudFrontWebDistribution {
    return new cloudfront.CloudFrontWebDistribution(this, "RootDistribution", {
      comment: `Distributions pointing to the root bucket of ${domain}`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      viewerProtocolPolicy: ViewerProtocolPolicy.ALLOW_ALL,
      viewerCertificate: ViewerCertificate.fromAcmCertificate(certificate, {aliases:[domain]}),
      // the default for defaultRootObject is index.html which causes issues with the redirect bucket.
      // e.g. naked domain + https redirects to www.domain.com/index.html which isn't quite right.
      defaultRootObject: "",
      // Using a custom origin config because we need to point to the S3 website URL not the regular bucket URL.
      // I need to use the S3 website url because only that URL supports redirects. S3 static websites are
      // HTTP only, hence using HTTPOnly.
      originConfigs: [
        {
          customOriginSource: {
            domainName: source.bucketWebsiteDomainName,
            originProtocolPolicy: OriginProtocolPolicy.HTTP_ONLY
          },
          behaviors: [
            {
              isDefaultBehavior: true
            }
          ]
        }
      ],
      loggingConfig: {
        bucket: logBucket,
        prefix: `cloudfront/${domain}/`
      }
    })
  }
}
