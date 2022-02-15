const httpStatusCode = require('http-status-codes');
const ErrorMessage = 'An error occurred loading the gopher details.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.handler = async (event, context) => {
  try {
    const gophers = await loadFromDynamo();
    if (!gophers) {
      return {
        statusCode: httpStatusCode.NOT_FOUND,
        body: JSON.stringify({ message: 'Could not find gophers in the system' }),
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
    else {
      const summaries = mapGopherSummary(gophers);
      return {
        statusCode: httpStatusCode.OK,
        body: JSON.stringify(summaries),
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

function mapGopherSummary(gophers){
  const summaries = [];
  gophers.forEach(gopher => {
    summaries.push({
      id: gopher.sk,
      name: gopher.name,
      ...gopher.type && { type: gopher.type},
      ...gopher.location && {location: gopher.location}
    });
  });

  return summaries;
}

async function loadFromDynamo() {
  const params = {
    TableName: process.env.TableName,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'gopher'
    }
  };

  const response = await documentClient.query(params).promise();
  if (response && response.Items) {
    return response.Items
  }
}