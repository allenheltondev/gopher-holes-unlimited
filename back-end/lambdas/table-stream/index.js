const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { SNSClient, PublishBatchCommand } = require('@aws-sdk/client-sns');
const sns = new SNSClient();

exports.handler = async (event) => {
  try {
    const snsEntries = [];
    event.Records.map(async (record) => {
      let newImage;
      switch (record.eventName) {
        case 'INSERT':
          newImage = unmarshall(record.dynamodb.NewImage);
          const snsEntry = await exports.handleNewRecord(newImage);
          if (snsEntry) {
            snsEntries.push(snsEntry);
          }
          break;
        default:
          break;
      }
    });

    if (snsEntries.length) {
      await exports.publishSNSTopics(snsEntries);
    }
  }
  catch (err) {
    console.error(err);
  }
};


exports.handleNewRecord = async (newRecord) => {
  if (exports.isGopher(newRecord)) {
    return exports.buildNewGopherEntry(newRecord);
  }
};

exports.isGopher = (record) => {
  return record.GSI1PK == 'gopher#';
};

exports.buildNewGopherEntry = (record) => {
  const entry = {
    Message: JSON.stringify({
      id: record.pk,
      name: record.data.name,
      location: record.data.location,
      ...record.data.type && { type: record.data.type }
    })
  }

  if (record.data.location.city) {
    entry.MessageAttributes = {
      locationCity: {
        DataType: 'String',
        StringValue: record.data.location.city
      },
      locationState: {
        DataType: 'String',
        StringValue: record.data.location.state
      }
    }
  }

  if (record.data.type) {
    const typeAttribute = {
      DataType: 'String',
      StringValue: record.data.type
    };

    if (entry.MessageAttributes) {
      entry.MessageAttributes.type = typeAttribute
    }
    else {
      entry.MessageAttributes = {
        type: typeAttribute
      }
    }
  }

  return entry;
};

exports.publishSNSTopics = async (entries) => {
  const command = exports.buildPublishBatchCommand(entries);
  await sns.send(command);
};

exports.buildPublishBatchCommand = (entries) => {
  return new PublishBatchCommand({
    PublishBatchRequestEntries: entries,
    TopicArn: process.env.GOPHER_ADDED_TOPIC_ARN
  });
};