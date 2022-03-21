const { StatusCodes } = require('http-status-codes');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const ddb = new DynamoDBClient();

exports.handler = async (event) => {
  try {
    const input = JSON.parse(event.body);
    const id = event.pathParameters.holeId;
    await exports.updateHole(id, input);

      return {
        statusCode: httpStatusCode.NO_CONTENT,
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
  }
  catch (err) {
    console.error(err);
    
    const response = {
      statusCode: httpStatusCode.INTERNAL_SERVER_ERROR,      
      headers: { 'Access-Control-Allow-Origin': '*' }
    }
    
    let message = 'Something went wrong';
    if (err.code == 'ConditionalCheckFailedException') {
      response.statusCode = StatusCodes.NOT_FOUND;
      message = 'A hole with the provided id could not be found';
    }

    response.body = JSON.stringify(message);
    return response;
  }
};

exports.updateHole = async (holeId, input) => {
  const command = exports.buildUpdateHoleCommand(holeId, input);
  await ddb.send(command);
};

exports.buildUpdateHoleCommand = (holeId, input) => {
  const params = {
    TableName: process.env.TABLE_NAME,
    Key: marshall({
      pk: holeId,
      sk: 'hole#'
    }),
    ConditionExpression: 'attribute_exists(#pk)',
    ExpressionAttributeNames: {
      '#pk': 'pk',
      '#data': 'data'
    },
    ExpressionAttributeValues: {}
  };

  let updateExpression = 'SET';
  for (const [key, value] of Object.entries(input)) {
    updateExpression = `${updateExpression} #data.#${key} = :${key},`
    params.ExpressionAttributeNames[`#${key}`] = key;
    params.ExpressionAttributeValues[`:${key}`] = value;
  }

  params.UpdateExpression = updateExpression.slice(0, -1);
  params.ExpressionAttributeValues = marshall(params.ExpressionAttributeValues);

  return new UpdateItemCommand(params);
};