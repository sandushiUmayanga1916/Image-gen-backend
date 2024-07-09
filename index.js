const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const port = 4000;

// Start the server and print the URLs
app.listen(port, () => {
  console.log(`API listening on port is ${port} `)
})
app.use(cors());
app.use(bodyParser.json());
dotenv.config();

const apiKey = process.env.API_KEY;
const openai = new OpenAI({ apiKey });

const MAX_RETRIES = 5;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

const validateStoryPrompt = (prompt) => {
  const promptPattern = /tell me a story|write a story|create a story/i;
  return promptPattern.test(prompt);
};

const makeChatRequest = async (message, retries = 0) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a story writer. Please write a creative story based on the following prompt. Only generate a story. Do not answer other types of questions.' },
          { role: 'user', content: message }
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      }
    );

    const content = response.data.choices[0].message.content;

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
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a summary generator. Summarize the following story.' },
          { role: 'user', content: story }
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
      }
    );

    const summary = response.data.choices[0].message.content;
    return summary;
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

const downloadImage = async (url, filepath) => {
  const response = await axios({
    url,
    responseType: 'stream',
  });
  const writer = fs.createWriteStream(filepath);

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let error = null;
    writer.on('error', err => {
      error = err;
      writer.close();
      reject(err);
    });
    writer.on('close', () => {
      if (!error) {
        resolve(filepath);
      }
    });
  });
};

const generateStoryName = (summary) => {
  const words = summary.split(' ');
  const filteredWords = words.filter(word => !['the', 'a', 'an', 'is', 'was', 'and', 'of', 'in', 'on'].includes(word.toLowerCase()));
  const nameWords = filteredWords.slice(0, Math.min(filteredWords.length, 3));
  const name = nameWords.join(' ');
  return name;
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

app.post('/api/pdf', async (req, res) => {
  const { story, imageUrl, storyName } = req.body;
  if (!story) {
    return res.status(400).json({ error: 'Story content is required' });
  }

  const doc = new PDFDocument();
  let buffers = [];

  doc.on('data', buffers.push.bind(buffers));
  doc.on('end', () => {
    const pdfData = Buffer.concat(buffers);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=story.pdf',
      'Content-Length': pdfData.length
    });
    res.end(pdfData);
  });

  // Add story name first
  doc.fontSize(28).fillColor('red').text(storyName, { align: 'center' });
  doc.moveDown();

  // Add image below the story name
  if (imageUrl) {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const imagePath = path.join(tempDir, 'image.png');
    await downloadImage(imageUrl, imagePath);
    doc.image(imagePath, { fit: [500, 500], align: 'center', valign: 'center' });
    doc.moveDown();
  }

  // Add the story text
  doc.addPage();
  doc.fillColor('black').fontSize(12).text(story);

  doc.end();
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

const describeImage = async (imageFilePath) => {
  try {
    const imageBuffer = fs.readFileSync(imageFilePath);
    const base64Image = imageBuffer.toString('base64');

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Create a detailed and creative story based on the image. The story should be at least 5 paragraphs long, describing the scene, characters, potential backstory, and imagined events related to the image."
            }
          ]
        }
      ],
      temperature: 1,
      max_tokens: 2000, // Increased to allow for longer responses
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    if (response && response.choices && response.choices.length > 0) {
      const choice = response.choices[0];
      if (choice && choice.message && typeof choice.message.content === 'string') {
        const content = choice.message.content;
        const paragraphs = content.split('\n\n').filter(p => p.trim().length > 0);
        
        if (paragraphs.length < 5) {
          throw new Error('Generated content has less than 5 paragraphs');
        }
        
        return content;
      } else {
        throw new Error('No valid message found in response');
      }
    } else {
      throw new Error('Unexpected response structure');
    }
  } catch (error) {
    console.error('Error in describeImage:', error.message || error);
    throw error;
  }
};

app.post('/api/describe-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const imageFilePath = req.file.path;

  try {
    const description = await describeImage(imageFilePath);
    res.json({ description });
  } catch (error) {
    console.error('Error in describe-image:', error.message || error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    fs.unlinkSync(imageFilePath); // Delete the temporary image file
  }
});


app.get('/test', (req, res) => {
  const message = `Server running test at http://localhost:${port}`;
  res.send(message);
});

// Root URL handler
app.get('/', (req, res) => {
  const message = `Server running at http://localhost:${port}`;
  res.send(message);
});

// Export the Express API
module.exports = app