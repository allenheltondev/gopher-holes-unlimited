const { DynamoDBClient, GetItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { StatusCodes } = require('http-status-codes');
const ddb = new DynamoDBClient();

exports.handler = async (event) => {
  try {
    const details = await exports.getGopherDetails(event.pathParameters.gopherId);
    if (!details) {
      return {
        statusCode: StatusCodes.NOT_FOUND,
        body: JSON.stringify({ message: 'A gopher with the provided id could not be found.' }),
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }
    if (event.queryStringParameters?.include?.toLowerCase() == 'holes') {
      const holes = await exports.getGopherHoles(event.pathParameters.gopherId);
      details.holes = holes;
    }

    return {
      statusCode: StatusCodes.OK,
      body: JSON.stringify(details),
      headers: { 'Access-Control-Allow-Origin': '*' }
    }
  }
  catch (err) {
    console.error(err);
    return {
      statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
      body: JSON.stringify({ message: 'Something went wrong' }),
      headers: { 'Access-Control-Allow-Origin': '*' }
    }
  }
};

exports.getGopherDetails = async (gopherId) => {
  const command = exports.buildGetItemCommand(gopherId);
  const result = await ddb.send(command);
  if (result?.Item) {
    return exports.mapGopherDetails(unmarshall(result.Item));
  }
};

exports.buildGetItemCommand = (gopherId) => {
  return new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({
      pk: gopherId,
      sk: 'gopher#'
    })
  });
};

exports.mapGopherDetails = (rawData) => {
  return {
    id: rawData.pk,
    name: rawData.data.name,
    location: {
      ...rawData.data.location.city && { city: rawData.data.location.city },
      ...rawData.data.location.state && { state: rawData.data.location.state },
      ...rawData.data.location.addressLine1 && { addressLine1: rawData.data.location.addressLine1 },
      ...rawData.data.location.addressLine2 && { addressLine2: rawData.data.location.addressLine2 },
      ...rawData.data.location.latitude && { latitude: rawData.data.location.latitude },
      ...rawData.data.location.longitude && { longitude: rawData.data.location.longitude },
    },
    status: rawData.data.status ?? 'unknown',
    timesSeen: rawData.data.timesSeen ?? 0,
    ...rawData.data.picture && { picture: rawData.data.picture },
    ...rawData.data.type && { type: rawData.data.type },
    ...rawData.data.sex && { sex: rawData.data.sex },
    ...rawData.data.color && { color: rawData.data.color },
    ...rawData.data.comment && { comment: rawData.data.comment }
  };
};

exports.getGopherHoles = async (gopherId) => {
  let holes = [];
  const command = exports.buildQueryCommand(gopherId);
  const result = await ddb.send(command);
  if (result?.Items?.length) {
    holes = result.Items.map(item => exports.mapGopherHole(unmarshall(item)));
  }

  return holes;
};

exports.buildQueryCommand = (gopherId) => {
  return new QueryCommand({
    TableName: process.env.TABLE_NAME,
    IndexName: process.env.GSI1_NAME,
    KeyConditionExpression: '#GSI1PK = :GSI1PK AND begins_with(#GSI1SK, :GSI1SK)',
    ExpressionAttributeNames: {
      '#GSI1PK': 'GSI1PK',
      '#GSI1SK': 'GSI1SK'
    },
    ExpressionAttributeValues: marshall({
      ':GSI1PK': gopherId,
      ':GSI1SK': 'link#'
    })
  })
};

exports.mapGopherHole = (rawData) => {
  return {
    id: rawData.pk,
    description: rawData.data.description,
    location: rawData.data.location
  };
};