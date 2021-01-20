const httpStatusCode = require('http-status-codes');
const ErrorMessage = 'An error occurred loading the hole details.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.lambdaHandler = async (event, context) => {
  try {
    const id = event.pathParameters.holeId;
    const hole = await loadFromDynamo(id);
    if (!hole) {
      return {
        statusCode: httpStatusCode.NOT_FOUND,
        body: JSON.stringify({ message: 'Could not find hole with the specified id' }),
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
    else {
      hole.id = hole.sk;
      delete hole.pk;
      delete hole.sk;

      return {
        statusCode: httpStatusCode.OK,
        body: JSON.stringify(hole),
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

async function loadFromDynamo(id) {
  const params = {
    TableName: process.env.TableName,
    Key: {
      pk: 'hole',
      sk: id
    }
  };

  const response = await documentClient.get(params).promise();
  if (response && response.Item) {
    return response.Item
  }
}