const httpStatusCode = require('http-status-codes');
const ErrorMessage = 'An error occurred loading the hole details.';
const dynamodb = require('aws-sdk/clients/dynamodb');
const documentClient = new dynamodb.DocumentClient();

exports.handler = async (event, context) => {
  try {
    const holes = await loadFromDynamo();
    if (!holes) {
      return {
        statusCode: httpStatusCode.NOT_FOUND,
        body: JSON.stringify({ message: 'Could not find holes in the system' }),
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
    else {
      const summaries = mapHoleSummary(holes);
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

function mapHoleSummary(holes){
  const summaries = [];
  holes.forEach(hole => {
    summaries.push({
      id: hole.sk,
      ...hole.location && {location: hole.location}
    });
  });

  return summaries;
}

async function loadFromDynamo() {
  const params = {
    TableName: process.env.TableName,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'hole'
    }
  };

  const response = await documentClient.query(params).promise();
  if (response && response.Items) {
    return response.Items
  }
}