const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();

app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.API_KEY });

const MAX_RETRIES = 5;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const validateStoryPrompt = (prompt) => {
  const promptPattern = /tell me a story|write a story|create a story/i;
  return promptPattern.test(prompt);
};

const makeChatRequest = async (message, retries = 0) => {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a story writer. Please write a creative story based on the following prompt. Only generate a story. Do not answer other types of questions.' },
        { role: 'user', content: message }
      ],
    });

    const content = completion.choices[0].message.content;

    if (!validateStoryPrompt(message)) {
      throw new Error('Invalid story prompt.');
    }

    return content;
  } catch (error) {
    if (error.response && error.response.status === 429 && retries < MAX_RETRIES) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '1', 10);
      await delay(retryAfter * 1000);
      return makeChatRequest(message, retries + 1);
    } else {
      console.error('Error in makeChatRequest:', error.message || error);
      throw error;
    }
  }
};

const summarizeStory = async (story) => {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a summary generator. Summarize the following story.' },
        { role: 'user', content: story }
      ],
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error in summarizeStory:', error.message || error);
    throw error;
  }
};

const generateImage = async (prompt) => {
  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt,
      n: 1,
      size: "1024x1024",
      response_format: "url"
    });

    return response.data[0].url;
  } catch (error) {
    console.error('Error in generateImage:', error.message || error);
    throw error;
  }
};

const generateStoryName = (summary) => {
  const words = summary.split(' ');
  const filteredWords = words.filter(word => !['the', 'a', 'an', 'is', 'was', 'and', 'of', 'in', 'on'].includes(word.toLowerCase()));
  const nameWords = filteredWords.slice(0, Math.min(filteredWords.length, 3));
  return nameWords.join(' ');
};

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  try {
    const story = await makeChatRequest(message);
    const summary = await summarizeStory(story);
    const imageUrl = await generateImage(summary);
    const storyName = generateStoryName(summary);

    res.json({ story, summary, imageUrl, storyName });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/regenerate-story', async (req, res) => {
  const { story, regeneratePrompt } = req.body;
  try {
    const newStory = await makeChatRequest(regeneratePrompt || story);
    res.json({ newStory });
  } catch (error) {
    console.error('Error in regenerate-story:', error.message || error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/regenerate-image', async (req, res) => {
  const { summary, regeneratePrompt } = req.body;
  try {
    const newImageUrl = await generateImage(regeneratePrompt || summary);
    res.json({ newImageUrl });
  } catch (error) {
    console.error('Error in regenerate-image:', error.message || error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

module.exports = app;