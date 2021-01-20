const httpStatusCode = require('http-status-codes');
const ErrorMessage = 'An error occurred deleting the gopher.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.lambdaHandler = async (event, context) => {
  try{
  const id = event.pathParameters.gopherId;

  await deleteFromDynamo(id);
  return {
    statusCode: httpStatusCode.NO_CONTENT,
    body: JSON.stringify({ id: id }),
    headers: { 'Access-Control-Allow-Origin': '*' }
  };
}
catch(err){
  console.log(err);
  return {
    statusCode: httpStatusCode.INTERNAL_SERVER_ERROR,
    body: JSON.stringify({ message: ErrorMessage }),
    headers: { 'Access-Control-Allow-Origin': '*' }
  };
}
};

async function deleteFromDynamo(id) {
  const params = {
    TableName: process.env.TableName,
    Key: {
      pk: 'gopher',
      sk: id
    }
  };

  await documentClient.delete(params).promise();
}