const { StatusCodes } = require('http-status-codes');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const ddb = new DynamoDBClient();
const sns = new SNSClient();

exports.handler = async (event) => {
  try {
    const id = event.pathParameters.gopherId;
    const input = JSON.parse(event.body);

    const previousData = await exports.updateGopherStatus(id, input.status);
    if (previousData.status != input) {
      await exports.publishGopherUpdatedMessage(id, input.status);
    }

    return {
      statusCode: StatusCodes.NO_CONTENT,
      headers: { 'Access-Control-Allow-Origin': '*' }
    };
  } catch (err) {
    console.error(err);

    let message = 'Something went wrong';
    const response = {
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      headers: { 'Access-Control-Allow-Origin': '*' }
    };

    if (err.code == 'ConditionalCheckFailedException') {
      response.statusCode = StatusCodes.NOT_FOUND;
      message = 'A gopher with the provided id could not be found';
    }

    response.body = JSON.stringify({ message });
    return response;
  }
};

exports.updateGopherStatus = async (gopherId, status) => {
  const command = exports.buildUpdateGopherStatusCommand(gopherId, status);

  const response = await ddb.send(command);
  if (response?.Attributes) {
    return unmarshall(response.Attributes);
  }
};

exports.buildUpdateGopherStatusCommand = (gopherId, status) => {
  return new UpdateItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: {
      pk: gopherId,
      sk: 'gopher#'
    },
    ConditionExpression: 'attribute_exists(#pk)',
    UpdateExpression: 'SET #data.#status = :status',
    ExpressionAttributeNames: {
      '#pk': 'pk',
      '#status': 'status'
    },
    ExpressionAttributeValues: marshall({
      ':status': status
    }),
    ReturnValues: 'UPDATED_OLD'
  });
};

exports.publishGopherUpdatedMessage = async (gopherId, status) => {
  const command = exports.buildPublishGopherUpdatedCommand(gopherId, status);

  await sns.send(command);
}

exports.buildPublishGopherUpdatedCommand = (gopherId, status) => {
  return new PublishCommand({
    TopicArn: process.env.GOPHER_UPDATED_TOPIC,
    Message: JSON.stringify({
      gopherId,
      status
    }),
    MessageAttributes: {
      gopherId: {
        DataType: 'String',
        StringValue: gopherId
      },
      status: {
        DataType: 'String',
        StringValue: status
      }
    }
  });
};