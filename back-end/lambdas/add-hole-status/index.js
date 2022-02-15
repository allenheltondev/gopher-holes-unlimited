const httpStatusCode = require('http-status-codes');
const ErrorMessage = 'An error occurred updating the hole status.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.handler = async (event, context) => {
  try {
    const id = event.pathParameters.holeId;
    const item = JSON.parse(event.body);

    await saveToDynamo(id, item.status);

    return {
      statusCode: httpStatusCode.NO_CONTENT,
      headers: { 'Access-Control-Allow-Origin': '*' }
    };
  } catch (err) {
    console.log(err);
    return {
      statusCode: httpStatusCode.INTERNAL_SERVER_ERROR,
      body: JSON.stringify({ message: ErrorMessage }),
      headers: { 'Access-Control-Allow-Origin': '*' }
    };
  }
};

async function saveToDynamo(id, status) {
  const params = {
    TableName: process.env.TableName,
    Key: {
      pk: 'hole',
      sk: id
    },
    UpdateExpression: 'set #status = :status',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: {
      ':status': status
    }
  };

  await documentClient.update(params).promise();
}