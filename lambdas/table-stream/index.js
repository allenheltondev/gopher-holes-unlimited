const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { SNSClient, PublishBatchCommand } = require("@aws-sdk/client-sns");

const sfn = new SFNClient();
const sns = new SNSClient();
const eventBridge = new EventBridgeClient();

exports.handler = async (event) => {
  try {
    const events = [];
    const snsMessages = [];
    await Promise.all(event.Records.map(async (record) => {
      let newImage;
      let oldImage;
      let event;
      switch (record.eventName) {
        case 'INSERT':
          newImage = unmarshall(record.dynamodb.NewImage);
          event = await exports.handleNewRecord(newImage);

          break;
        case 'MODIFY':
          newImage = unmarshall(record.dynamodb.NewImage);
          oldImage = unmarshall(record.dynamodb.OldImage);
          event = exports.handleModifiedRecord(oldImage, newImage);
        default:
          break;
      }

      if (event?.type == 'eventbridge') {
        events.push(event.data);
      }
      else if(event?.type = 'sns') {
        let topicGroup = snsMessages.find(sm => sm.TopicArn == event.data.TopicArn);
        if(!topicGroup){
          topicGroup = {
            TopicArn: event.data.TopicArn,
            messages: []
          };
          snsMessages.push(topicGroup);
        }
        topicGroup.messages.push(event.data.body);
      }
    }));

    await Promise.all([
      await exports.publishEvents(events),
      await exports.publishBatchSnsMessages(snsMessages)
    ]);
  }
  catch (err) {
    console.error(err);
  }
};

exports.handleNewRecord = async (newRecord) => {
  if (exports.isAddGopherJob(newRecord)) {
    await exports.startAddGopherJob(newRecord);
  }
  else if (exports.isHole(newRecord)) {
    if (newRecord.data.gopherId) {
      return exports.buildGopherHoleLinkedEvent(newRecord, true);
    }
  }
};

exports.handleModifiedRecord = (oldRecord, newRecord) => {
  if (exports.isHole(newRecord)) {
    if (!oldRecord.data.gopherId && newRecord.data.gopherId) {
      return exports.buildGopherHoleLinkedEvent(newRecord, true);
    }
    else if (oldRecord.data.gopherId && !newRecord.data.gopherId) {
      return exports.buildGopherHoleLinkedEvent(oldRecord, false);
    }
  }
  else if (exports.isAddGopherJob(newRecord)) {
    return exports.buildGoperUpdatedSnsMessage(newRecord);
  }
};

exports.isAddGopherJob = (record) => {
  return record.sk == 'job#addGopher';
};

exports.isHole = (record) => {
  return record.sk == 'hole#';
};

exports.isGopher = (record) => {
  return record.sk = 'gopher#';
};

exports.buildGopherUpdatedSnsMessage = (record) => {
  return {
    type: 'sns',
    data: {
      TopicArn: process.env.GOPHER_UPDATED_TOPIC_ARN,
      body: {
        Message: JSON.stringify({
          id: record.pk,
          name: record.data.name
        })        
      }
    }
  };
};

exports.buildGopherHoleLinkedEvent = (record, isNewLink) => {
  return {
    type: 'eventbridge',
    data: {
      Detail: 'Gopher Hole Linked',
      DetailType: JSON.stringify({
        gopherId: record.data.gopherId,
        holeId: record.pk,
        holeDescription: record.data.description,
        isNewHoleLinked: isNewLink
      }),
      Source: 'GHU'
    }
  };
};

exports.startAddGopherJob = async (record) => {
  const command = new StartExecutionCommand({
    stateMachineArn: process.env.ADD_GOPHER_STATE_MACHINE_ARN,
    input: JSON.stringify({
      id: record.pk
    })
  })

  await sfn.send(command);
};

exports.publishEvents = async (entries) => {
  const command = exports.buildPutEventsCommand(entries);
  await eventBridge.send(command);
};

exports.buildPutEventsCommand = (entries) => {
  return new PutEventsCommand({
    Entries: entries
  });
};

exports.publishBatchSnsMessages = (snsMessages) => {
  await Promise.all(snsMessages.map(async (batch) => {
    const command = exports.buildPublishBatchSnsMessageCommand(batch);
    await sns.send(command);
  }));
};

exports.buildPublishBatchSnsMessageCommand = (batch) => {
  return new PublishBatchCommand({
    TopicArn: batch.TopicArn,
    PublishBatchRequestEntries: batch.messages
  });
};