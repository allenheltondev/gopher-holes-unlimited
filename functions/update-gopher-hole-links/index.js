const { DynamoDBClient, QueryCommand, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const ddb = new DynamoDBClient();

exports.handler = async (event, context, callback) => {
  try {
    const message = JSON.parse(event.detail);
    const links = await exports.getGopherHoleLinks(message.holeId);
    if (links?.length) {
      await exports.updateGopherHoleLinks(links, message.status);
    }
  }
  catch (err) {
    console.error(err);
    callback(new Error('Unable to link/unlink gopher hole'));
  }
};

exports.getGopherHoleLinks = async (holeId) => {
  const command = exports.buildQueryGopherHoleLinksCommand(holeId);
  const result = await ddb.send(command);
  if (result?.Items?.length) {
    return result.Items.map(item => unmarshall(item));
  }
};

exports.buildQueryGopherHoleLinksCommand = (holeId) => {
  return new QueryCommand({
    TableName: process.env.TABLE_NAME,
    KeyConditionExpression: '#pk = :pk and begins_with(#sk, :sk)',
    ConditionAttibuteNames: {
      '#pk': 'pk',
      '#sk': 'sk'
    },
    ConditionAttributeValues: marshall({
      ':pk': holeId,
      ':sk': 'link#'
    })
  });
};

exports.updateGopherHoleLinks = async (links, status) => {
  const updates = links.map(link => exports.buildUpdateLinkItem(link, status));
  let batch;
  do {
    batch = updates.splice(0, 25);
    const command = exports.buildBatchUpdateLinksCommand(batch);
    await ddb.send(command);
  } while (updates.length)
};

exports.buildUpdateLinkItem = (link, status) => {
  return {
    PutRequest: {
      Item: {
        ...link,
        status: status
      }
    }
  };
};

exports.buildBatchUpdateLinksCommand = (batch) => {
  return new BatchWriteItemCommand({
    [process.env.TABLE_NAME]: batch
  });
};