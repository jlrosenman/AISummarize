require('dotenv').config();
const axios = require('axios');
const express = require('express');
const { WebClient } = require('@slack/web-api');

const app = express();  // <-- THIS LINE IS CRUCIAL
const port = process.env.PORT || 3000;

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

const TEAM_CHANNELS = {
  team_1: process.env.TEAM_1_CHANNEL_ID,
  team_2: process.env.TEAM_2_CHANNEL_ID,
  team_3: process.env.TEAM_3_CHANNEL_ID,
};

// Middleware to parse Slack requests
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Handle /summarize slash command
app.post('/slack/commands', async (req, res) => {
  const { command, text, user_id, channel_id } = req.body;

  if (command !== '/summarize') {
    return res.status(400).send('Unsupported command.');
  }

  try {
    // Send user summary text to chatbot API
    const chatbotResponse = await axios.post(`${process.env.SPARKY_AI}/conversations/chat/`, { message: text });
    const replyText = chatbotResponse.data.reply || 'No reply from chatbot';

    // Post chatbot reply publicly to target Slack channel
    await slackClient.chat.postMessage({
      channel: TARGET_CHANNEL_ID,
      text: replyText,
    });

    // Send ephemeral confirmation with a button back to user
    return res.json({
      channel: channel_id,
      user: user_id,
      text: '✅ Your summary request has been processed and posted.',
      blocks: [
        {
          type: 'section',
          text: { type: 'plain_text', text: '✅ Your summary request has been processed and posted.' },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '📤 Open Submit Form', emoji: true },
              value: JSON.stringify({ summary: text, user_id }),
              action_id: 'open_submit_modal',
            },
          ],
        },
      ],
    });

  } catch (error) {
    console.error('Error processing summary:', error);
    return res.status(500).send('Failed to process summary.');
  }
});

// Handle interactive components (buttons + modals)
app.post('/slack/interactions', async (req, res) => {
  let payload;

  try {
    payload = JSON.parse(req.body.payload);
  } catch (err) {
    console.error('Invalid payload:', err);
    return res.sendStatus(400);
  }

  // Handle "Open Submit Form" button click
  if (payload.type === 'block_actions' && payload.actions[0].action_id === 'open_submit_modal') {
    const data = JSON.parse(payload.actions[0].value);

    try {
      await slackClient.views.open({
        trigger_id: payload.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'submit_summary_modal',
          title: { type: 'plain_text', text: 'Send to Teams' },
          submit: { type: 'plain_text', text: 'Send' },
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `📌 *Summary from* <@${data.user_id}>:\n>${data.summary}` },
            },
            {
              type: 'input',
              block_id: 'team_select',
              label: { type: 'plain_text', text: 'Select team(s) to send this to:' },
              element: {
                type: 'multi_static_select',
                action_id: 'teams',
                placeholder: { type: 'plain_text', text: 'Select teams' },
                options: [
                  { text: { type: 'plain_text', text: 'team 1' }, value: 'team_1' },
                  { text: { type: 'plain_text', text: 'team 2' }, value: 'team_2' },
                  { text: { type: 'plain_text', text: 'team 3' }, value: 'team_3' },
                ],
              },
            },
            {
               type: 'input',
              block_id: 'message_input',
              label: { type: 'plain_text', text: 'Message to send:' },
              element: {
                type: 'plain_text_input',
                action_id: 'message',
                multiline: true,
                initial_value: 'Hi team! Please see the below change management ticket.',
              },
            },
          ],
        },
      });

      return res.sendStatus(200);
    } catch (err) {
      console.error('Error opening modal:', err);
      return res.sendStatus(500);
    }
  }

  // Handle modal submission
  if (payload.type === 'view_submission' && payload.view.callback_id === 'submit_summary_modal') {
    const values = payload.view.state.values;
    const selectedTeams = values.team_select.teams.selected_options.map(opt => opt.value);
    const message = values.message_input.message.value;

    for (const team of selectedTeams) {
      const channelId = TEAM_CHANNELS[team];
      if (channelId) {
        try {
          await slackClient.chat.postMessage({
            channel: channelId,
            text: `📣 Message from <@${payload.user.id}>:\n>${message}`,
          });
        } catch (err) {
          console.error(`Error sending to ${team}:`, err);
        }
      }
    }

    return res.json({ response_action: 'clear' });
  }

  return res.sendStatus(200);
});

// Start server
app.listen(port, () => {
  console.log(`✅ Slack bot server running on port ${port}`);
});
