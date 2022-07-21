const { StatusCodes } = require('http-status-codes');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const ddb = new DynamoDBClient();

exports.handler = async (event, context) => {
  try {
    const id = event.pathParameters.holeId;
    const hole = await exports.getHole(id);
    if (!hole) {
      return {
        statusCode: StatusCodes.NOT_FOUND,
        body: JSON.stringify(hole),
        headers: { 'Access-Control-Allow-Origin': '*' }
      };
    }

    if (event.queryStringParameters?.include == 'gopher' && hole.gopher?.id) {
      const gopher = await exports.getGopher(hole.gopher.id);
      if (gopher) {
        hole.gopher.name = gopher.data.name;
      }
    } else {
      delete hole.gopher;
    }

    return {
      statusCode: StatusCodes.OK,
      body: JSON.stringify(hole),
      headers: { 'Access-Control-Allow-Origin': '*' }
    };

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

exports.getHole = async (holeId) => {
  const command = exports.buildGetHoleCommand(holeId);
  const response = await ddb.send(command);
  if (response?.Item) {
    const item = unmarshall(response.Item);
    return exports.mapHole(item);
  }
};

exports.buildGetHoleCommand = (holeId) => {
  return new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({
      pk: holeId,
      sk: 'hole#'
    })
  });
};

exports.mapHole = (item) => {
  return {
    id: item.pk,
    location: item.data.location,
    description: item.data.description,
    status: item.data.status ?? 'unknown',
    addedDate: new Date(Number(item.GSI1SK) * 1000).toISOString(),
    ...item.data?.comment && { comment: item.data.comment },
    ...item.data?.gopherId && { gopherId: item.data.gopherId }
  };
};

exports.getGopher = async (gopherId) => {
  const command = exports.buildGetGopherCommand(gopherId);
  const response = await ddb.send(command);
  if (response?.Item) {
    return unmarshall(response.Item);
  }
};

exports.buildGetGopherCommand = (gopherId) => {
  return new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({
      pk: gopherId,
      sk: 'gopher#'
    })
  });
};