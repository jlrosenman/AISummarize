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
 const { command, text, user_id, channel_id, response_url } = req.body;
 if (!['/inform', '/approval'].includes(command)) {
  return res.status(400).send('Unsupported command.');
 }
 // Respond to Slack *immediately*
 res.status(200).send(); // :point_left: Immediate empty response to avoid Slack timeout
 // Begin async processing AFTER response
 let summary = text;
 let jiraDescriptionOnly = '';
 const jiraMatch = text.match(/([A-Z]+-\d+)/);
 if (jiraMatch) {
  const issueKey = jiraMatch[1];
  try {
   const jiraRes = await axios.get(
    `https://${process.env.JIRA_DOMAIN}/rest/api/2/issue/${issueKey}`,
    {
     auth: {
      username: process.env.JIRA_USERNAME,
      password: process.env.JIRA_PASSWORD,
     },
    }
   );
   const issue = jiraRes.data;
   // Just store the description
   jiraDescriptionOnly = issue.fields.description || '';
   // :white_check_mark: Truncate it here, just in case it's too large
   if (jiraDescriptionOnly.length > 100) {
    jiraDescriptionOnly = jiraDescriptionOnly.substring(0, 100) + '\n...(truncated)';
   }
   // Send Jira info directly to user as DM
   await slackClient.chat.postMessage({
    channel: user_id,
    text: `:information_source: Jira info for ${issueKey}:\n${jiraDescriptionOnly || 'No description found.'}`,
   });
  } catch (err) {
   console.error(`:warning: Failed to fetch Jira ticket: ${issueKey}`, err.message);
  }
 }
 // Now send the interactive message to response_url (without Jira info in modal)
 try {
  await axios.post(response_url, {
   response_type: 'ephemeral', // or 'in_channel'
   blocks: [
    {
     type: 'section',
     text: { type: 'plain_text', text: ':white_check_mark: Your request has been processed and posted.' },
    },
    {
     type: 'actions',
     elements: [
      {
       type: 'button',
       text: { type: 'plain_text', text: ':outbox_tray: Open Submit Form', emoji: true },
       value: JSON.stringify({
        summary: summary, // Only raw text, no Jira info
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
  console.error('Error posting to response_url:', error);
 }
});

// Add a new route to handle Slack interactive events (like view_submission)
app.post('/slack/interactions', async (req, res) => {
  const payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload;

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
