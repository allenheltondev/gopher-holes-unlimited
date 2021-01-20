const httpStatusCode = require('http-status-codes');
const ErrorMessage = 'An error occurred saving the hole.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.lambdaHandler = async (event, context) => {
  try {
    const item = JSON.parse(event.body);
    const id = event.pathParameters.holeId;
    item.pk = 'hole';
    item.sk = id;

    const errorMessage = await saveToDynamo(item);
    if (errorMessage) {
      return {
        statusCode: httpStatusCode.NOT_FOUND,
        body: JSON.stringify({ message: errorMessage }),
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
    else {
      return {
        statusCode: httpStatusCode.NO_CONTENT,
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
  }
  catch (err) {
    console.log(err);
    return {
      statusCode: httpStatusCode.INTERNAL_SERVER_ERROR,
      body: JSON.stringify({ message: ErrorMessage }),
      headers: { 'Access-Control-Allow-Origin': '*' }
    }
  }
};

function buildDynamoParams(item) {
  const params = {
    TableName: process.env.TableName,
    Item: item,
    ConditionExpression: 'pk = :pk and sk = :sk',
    ExpressionAttributeValues: {
      ':pk': 'hole',
      ':sk': item.sk
    }
  };

  return params;
}

async function saveToDynamo(item) {
  try {
    const params = buildDynamoParams(item);

    await documentClient.put(params).promise();
  } catch (err) {
    console.log('An error occurred updating item to Dynamo');
    console.log(err);

    if (err.code == 'ConditionalCheckFailedException') {
      return 'Could not find hole with the specified id';
    }
    throw err;
  }
}