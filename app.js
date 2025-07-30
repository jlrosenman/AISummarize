import dotenv from 'dotenv';
import { WebClient } from '@slack/web-api';
import axios from 'axios';
import express from 'express';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID;
const TEAM_CHANNELS = {
  team_1: process.env.TEAM_1_CHANNEL_ID,
  team_2: process.env.TEAM_2_CHANNEL_ID,
  team_3: process.env.TEAM_3_CHANNEL_ID,
};

const channelInfo1 = await slackClient.conversations.info({ channel: TEAM_CHANNELS.team_1 });
const firstChannelName = channelInfo1.channel.name;

const channelInfo2 = await slackClient.conversations.info({ channel: TEAM_CHANNELS.team_2 });
const secondChannelName = channelInfo2.channel.name;

const channelInfo3 = await slackClient.conversations.info({ channel: TEAM_CHANNELS.team_3 });
const thirdChannelName = channelInfo3.channel.name;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const initialMessages = {
  '/inform': (summary) => `Hi team, we are starting the following change. Please reach out to the help-network-datacenter channel with any related alerts or issues.Thanks!\n\n${summary}`,
  '/approval': (summary) => `Hi @person! Approval needed! Please review the attached request:\n\n${summary}`,
};

app.post('/slack/commands', async (req, res) => {
  const { command, text, user_id, channel_id } = req.body;

  if (!['/inform', '/approval'].includes(command)) {
    return res.status(400).send('Unsupported command.');
  }

  try {
    return res.json({
      channel: channel_id,
      user: user_id,
      text: '✅ Your request has been processed and posted.',
      blocks: [
        {
          type: 'section',
          text: { type: 'plain_text', text: '✅ Your request has been processed and posted.' },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '📤 Open Submit Form', emoji: true },
              value: JSON.stringify({
                summary: text,
                user_id,
                command,
              }),
              action_id: 'open_submit_modal',
            },
          ],
        },
      ],
    });
  } catch (error) {
    console.error('Error processing command:', error);
    return res.status(500).send('Failed to process request.');
  }
});

app.post('/slack/interactions', async (req, res) => {
  let payload;

  try {
    payload = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('Invalid payload:', err);
    return res.sendStatus(400);
  }

  if (payload.type === 'block_actions' && payload.actions[0].action_id === 'open_submit_modal') {
    const data = JSON.parse(payload.actions[0].value);

    try {
      const prepopulatedMessage = initialMessages[data.command](data.summary);

      const blocks = [
        {
          type: 'input',
          block_id: 'channel_select',
          label: { type: 'plain_text', text: 'Select channels(s) to send this to:' },
          element: {
            type: 'multi_static_select',
            action_id: 'channels',
            placeholder: { type: 'plain_text', text: 'Select channels' },
            options: data.command === '/approval'
              ? [
                  { text: { type: 'plain_text', text: firstChannelName }, value: TEAM_CHANNELS.team_1 },
                  { text: { type: 'plain_text', text: secondChannelName }, value: TEAM_CHANNELS.team_2 },
                ]
              : [
                  { text: { type: 'plain_text', text: firstChannelName }, value: TEAM_CHANNELS.team_1 },
                  { text: { type: 'plain_text', text: secondChannelName }, value: TEAM_CHANNELS.team_2 },
                  { text: { type: 'plain_text', text: thirdChannelName }, value: TEAM_CHANNELS.team_3 },
                ],
          },
        },
      ];

      if (data.command === '/approval') {
        blocks.push({
          type: 'input',
          block_id: 'user_select',
          label: { type: 'plain_text', text: 'Select person(s) to @mention for approval' },
          element: {
            type: 'multi_users_select',
            action_id: 'mention',
            placeholder: { type: 'plain_text', text: 'Choose users' },
            initial_users: [DEFAULT_USER_ID], // default user selected
          },
         "element":{
          "type": "plain_text_input",
          "action_id": "input1",
          "placeholder":{
            "type": "plain_text",
            "text": "Type in here"
          },
          "multiline":true
         }
        });
      }

      blocks.push({
        type: 'input',
        block_id: 'message_input',
        label: { type: 'plain_text', text: 'Message to send:' },
        element: {
          type: 'plain_text_input',
          action_id: 'message',
          multiline: true,
          initial_value: prepopulatedMessage,
        },
      });

      await slackClient.views.open({
        trigger_id: payload.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'submit_summary_modal',
          title: { type: 'plain_text', text: 'Send to Channels' },
          submit: { type: 'plain_text', text: 'Send' },
          blocks,
        },
      });

      return res.sendStatus(200);
    } catch (err) {
      console.error('Error opening modal:', err);
      return res.sendStatus(500);
    }
  }

  if (payload.type === 'view_submission' && payload.view.callback_id === 'submit_summary_modal') {
    const values = payload.view.state.values;
    const selectedChannelIds = values.channel_select.teams.selected_options.map(opt => opt.value);
    let message = values.message_input.message.value;

    if ('user_select' in values && values.user_select.mention?.selected_users) {
      const userIds = values.user_select.mention.selected_users;
      const mentionString = userIds.map(id => `<@${id}>`).join(' ');

      if (/@person/gi.test(message)) {
        message = message.replace(/@person/gi, mentionString);
      } else {
        message = `${mentionString}\n\n${message}`;
      }
    }

    console.log('Selected channels:', selectedChannelIds);
    console.log('Message:', message);
    console.log('User ID:', payload.user.id);

    for (const channelId of selectedChannelIds) {
      try {
        await slackClient.chat.postMessage({
          channel: channelId,
          text: `📣 Message from <@${payload.user.id}>:\n${message}`,
        });
        console.log(`Message sent to channel ${channelId}`);
      } catch (err) {
        console.error(`Error sending to channel ${channelId}:`, err);
      }
    }

    return res.json({ response_action: 'clear' });
  }

  return res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`✅ Slack bot server running on port ${port}`);
});
