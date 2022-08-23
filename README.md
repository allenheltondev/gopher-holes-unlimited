[![Twitter][1.1]][1] [![GitHub][2.1]][2] [![LinkedIn][3.1]][3] [![Ready, Set, Cloud!][4.1]][4]
# Gopher Holes Unlimited Reference Guide
![Gopher Holes Unlimited Logo](https://readysetcloud.s3.amazonaws.com/GHU.png)

## Description

Welcome to the reference guide for how to build a serverless, API-first application! 

## Contents
In this repo you will find:
* OAS3.0 spec defining the *Gopher Holes Unlimited* API. It contains the endpoints, component schemas, and example responses
* 3 Postman Collections
    * Mock Server Collection
    * Documentation Collection
    * Test Suite/Automation Collection

The Postman collections are intended to be consumed from [Postman](https://postman.com) itself, and is highly recommended you import them into your workspace to get the full effect.

## Infrastructure
Below is an auto-generated [infrastructure diagram](https://www.readysetcloud.io/blog/allen.helton/the-5-types-of-architecture-diagrams/#the-infrastructure-diagram) describing the serverless API built by the SAM template in this repository. The resources outlined in the diagram below will be deployed into your AWS account.

![AWS infrastructure diagram](/diagrams/diagram.png)

## AWS Components

Gopher Holes Unlimited is written using a serverless-first approach to technical implementation. It takes into consideration everything from [API Gateway](https://aws.amazon.com/api-gateway/) to [Lambda](https://aws.amazon.com/lambda/) to [SNS](https://aws.amazon.com/sns) and everything in between. 

It uses [event-driven architecture](https://aws.amazon.com/event-driven-architecture/) to orchestrate long running workflows like adding a gopher or to [choreograph](https://www.techtarget.com/searchapparchitecture/tip/Orchestration-vs-choreography-in-microservices-architecture) events like linking a hole to a gopher after it is created.

The add-gopher state machine integrates with the AWS SDK directly without the need for lambda functions. It is intended to be used as an example for long-running asynchronous jobs. To provide updates along the way, the state machine integrates with our **[AWS WebSocket microservice](https://github.com/allenheltondev/serverless-websockets)**. 

The application is built with the [AWS SDK v3 in NodeJS](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/index.html). For tips and tricks for upgrading from v2 to v3, check out [my blog post](https://www.readysetcloud.io/blog/allen.helton/lessons-learned-from-switching-to-aws-sdk-v3/).

## Auth

This API is protected by an API key. To generate an API key, we use the [serverless-api-key-registration repository](https://www.github.com/allenheltondev/serverless-api-key-registration) stack to automatically add a registration mechanism. To generate one for yourself, you can call the following url:

**POST** https://api.gopherholesunlimited.com/register/api-keys
```json
{
    "name": "<youruniqueidentifier>"
}
```
The name you provide must be **all lower case with no spaces, numbers, or special characters**. 

This call will return an API key that you can provide in an `x-api-key` header to all calls to the Gopher Holes Unlimited API.

## Postman and API Integrations

### REST API with Open API Spec

This repository started as the follow-along guide to [my blog post](https://www.readysetcloud.io/blog/allen.helton/api-first-development-with-postman/), so if you want more detail on what you're looking at, hop over there!

My goal is to introduce beginners to defining an API before writing any code. With [OpenAPI Specification (OAS)](https://openapis.org), you can define all aspects of an api. The data shape, the endpoints, security (not included in this example), and expected responses.

Learning how to write in the spec not only provides the developer with a useful skillset, but it also provides other developers a familiar experience.

[Postman](https://www.postman.com) stitches together the OAS definition with robust functionality like mock servers, web tests, and documentation right out of the box. The [blog post](https://www.readysetcloud.io/blog/allen.helton/api-first-development-with-postman/) walks you through how to set it up and start testing.

To view the Open API spec (which includes direct AWS integrations), check out [openapi.yaml](./openapi.yaml)

### Event-Based API with Async API Spec

This solution also uses events to communicate internally and externally. To document events, we use the [Async API Spec](https://www.asyncapi.com/) to show users which events can be subscribed or published to. 

Async API differs from Open API in that it defines `channels` instead of `endpoints`. A *channel* is a logical collection of events that perform related business functionality. An *endpoint* is a direct call a user can make that performs an action against an individual or set of resources.

With both the Async API and Open API specs, we can draw a complete picture of our serverless solution and how users may interact with it. For more details on how to write an Async API spec, refer to [this post on documenting a WebSocket API](https://www.readysetcloud.io/blog/allen.helton/intro-to-aws-websockets-part-three/).

To view the Async API spec for Gopher Holes unlimited, check out [asyncapi.yaml](./asyncapi.yaml).

## Like This?
If you like this repo and the accompanying blog post, show your support by following me on [Twitter][1] or connecting with me on [LinkedIn][3]. I'm always happy to answer any questions you might have and am open to any ideas you'd like to see turned into an article on my [blog][4]!


[1.1]: http://i.imgur.com/tXSoThF.png
[2.1]: http://i.imgur.com/0o48UoR.png
[3.1]: http://i.imgur.com/lGwB1Hk.png
[4.1]: https://readysetcloud.s3.amazonaws.com/logo.png

[1]: http://www.twitter.com/allenheltondev
[2]: http://www.github.com/allenheltondev
[3]: https://www.linkedin.com/in/allen-helton-85aa9650/
[4]: https://readysetcloud.io
