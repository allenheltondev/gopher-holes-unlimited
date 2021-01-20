const httpStatusCode = require('http-status-codes');
const ErrorMessage = 'An error occurred loading the gopher details.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.lambdaHandler = async (event, context) => {
  try {
    const id = event.pathParameters.gopherId;
    const gopher = await loadFromDynamo(id);
    if (!gopher) {
      return {
        statusCode: httpStatusCode.NOT_FOUND,
        body: JSON.stringify({ message: 'Could not find gopher with the specified id' }),
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
    else {
      gopher.id = gopher.sk;
      delete gopher.pk;
      delete gopher.sk;

      return {
        statusCode: httpStatusCode.OK,
        body: JSON.stringify(gopher),
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
      pk: 'gopher',
      sk: id
    }
  };

  const response = await documentClient.get(params).promise();
  if (response && response.Item) {
    return response.Item
  }
}