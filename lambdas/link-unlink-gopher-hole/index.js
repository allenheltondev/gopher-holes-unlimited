const { DynamoDBClient, PutItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const ddb = new DynamoDBClient();

exports.handler = async (event, context, callback) => {
  try {
    const message = event.detail;
    if (message.isNewHoleLinked) {
      await exports.linkNewGopherHole(message.gopherId, message.holeId, message.holeDescription);
    }
    else {
      await exports.deleteGopherHoleLink(message.gopherId, message.holeId);
    }
  }
  catch (err) {
    console.error(err);
    callback(new Error('Unable to link/unlink gopher hole'));
  }
};

exports.linkNewGopherHole = async (gopherId, holeId) => {
  const command = exports.buildPutItemCommand(gopherId, holeId);
  await ddb.send(command);
};

exports.buildPutItemCommand = (gopherId, holeId, description) => {
  return new PutItemCommand({
    TableName: process.env.TABLE_NAME,
    Item: marshall({
      pk: holeId,
      sk: `link#${gopherId}`,
      GSI1PK: gopherId,
      GSI1SK: `link#${holeId}`,
      description: description
    })
  });
};

exports.deleteGopherHoleLink = async (gopherId, holeId) => {
  const command = exports.buildDeleteItemCommand(gopherId, holeId);
  await ddb.send(command);
};

exports.buildDeleteItemCommand = (gopherId, holeId) => {
  return new DeleteItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: marshall({
      pk: holeId,
      sk: `link#${gopherId}`
    })
  });
};