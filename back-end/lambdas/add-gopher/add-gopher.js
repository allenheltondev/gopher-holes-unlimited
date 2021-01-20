const httpStatusCode = require('http-status-codes');
const short = require('short-uuid');
const ErrorMessage = 'An error occurred saving the gopher.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.lambdaHandler = async (event, context) => {
  const item = JSON.parse(event.body);

  const id = await saveToDynamo(item);
  if (!id) {
    return {
      statusCode: httpStatusCode.INTERNAL_SERVER_ERROR,
      body: JSON.stringify({ message: ErrorMessage }),
      headers: { 'Access-Control-Allow-Origin': '*' }
    };
  }
  else {
    return {
      statusCode: httpStatusCode.CREATED,
      body: JSON.stringify({ id: id }),
      headers: { 'Access-Control-Allow-Origin': '*' }
    };
  }
};

async function saveToDynamo(item) {
  try {
    const id = short.generate();
    item.pk = 'gopher';
    item.sk = id;
    const params = {
      TableName: process.env.TableName,
      Item: item
    };

    await documentClient.put(params).promise();
    return id;
  } catch (err) {
    console.log('An error occurred adding item to Dynamo');
    console.log(err);
  }
}