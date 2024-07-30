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
  console.log(`API listening on PORT ${port} `)
})

app.use(cors());
app.use(bodyParser.json());
dotenv.config();

const apiKey = process.env.API_KEY;
const openai = new OpenAI({ apiKey });

const MAX_RETRIES = 5;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

const validateStoryPrompt = (prompt) => {
  const promptPattern = /tell me a story|write a story|create a story/i;
  return promptPattern.test(prompt);
};

const escapeJsonString = (str) => {
  return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Remove control characters
};

const makeChatRequest = async (message, numChapters, maxWordsPerChapter, retries = 0) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: `You are a story writer. Please write a creative story based on the following prompt. The story should be divided into ${numChapters} chapters, each with a unique name. Each chapter should not exceed ${maxWordsPerChapter} words. Format the response as JSON with keys: chapter1, chapter1Name, chapter2, chapter2Name, etc.` },
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

    let content = response.data.choices[0].message.content;


    // Escape control characters
    content = escapeJsonString(content);

    // Try parsing JSON
    try {
      const storyData = JSON.parse(content);
      return storyData;
    } catch (parseError) {
      console.error('Error parsing JSON:', parseError);
      console.error('Content that caused the error:', content);
      throw new Error('Failed to parse JSON response');
    }
  } catch (error) {
    if (error.response && error.response.status === 429 && retries < MAX_RETRIES) {
      console.log(`Rate limited. Retrying in ${(retries + 1) * 1000} ms...`);
      await delay((retries + 1) * 1000);
      return makeChatRequest(message, numChapters, maxWordsPerChapter, retries + 1);
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
      size: "1024x1024",  // Change this to a valid size
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
  const { message, numChapters, maxWordsPerChapter } = req.body;

  try {
    const storyData = await makeChatRequest(message, numChapters, maxWordsPerChapter);
    const summary = await summarizeStory(Object.values(storyData).join('\n\n'));
    const storyName = generateStoryName(summary);

    // Generate images for each chapter
    const imageUrls = await Promise.all(
      Object.keys(storyData)
        .filter(key => key.startsWith('chapter') && !key.endsWith('Name'))
        .map(async (chapterKey) => {
          const chapterSummary = await summarizeStory(storyData[chapterKey]);
          return generateImage(chapterSummary);
        })
    );

    res.json({ ...storyData, summary, imageUrls, storyName });
  }catch (error) {
    console.error('Detailed error in /api/chat:', error);
    if (error.response) {
      console.error('Error response:', error.response.data);
    }
    res.status(500).json({ 
      error: 'An error occurred while generating the story and images.',
      details: error.message,
      responseData: error.response ? error.response.data : null
    });
  }
});

app.post('/api/pdf', async (req, res) => {
  const { storyData, imageUrls, storyName } = req.body;
  if (!storyData) {
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

  // Add story name
  doc.fontSize(28).fillColor('red').text(storyName, { align: 'center' });
  doc.moveDown();

  const chapterKeys = Object.keys(storyData).filter(key => key.startsWith('chapter') && !key.endsWith('Name'));

  for (let i = 0; i < chapterKeys.length; i++) {
    const chapterKey = chapterKeys[i];
    const chapterNameKey = `${chapterKey}Name`;
    const chapterContent = storyData[chapterKey];
    const chapterName = storyData[chapterNameKey];

    // Add chapter name
    doc.fontSize(20).fillColor('blue').text(`Chapter ${i + 1}: ${chapterName}`, { align: 'center' });
    doc.moveDown();

    // Add chapter image
    if (imageUrls[i]) {
      const imageBuffer = await downloadImageToBuffer(imageUrls[i]);
      doc.image(imageBuffer, { fit: [500, 500], align: 'center', valign: 'center' });
      doc.moveDown();
    }

    // Add chapter content
    const paragraphs = chapterContent.split('\n\n');
    paragraphs.forEach(paragraph => {
      doc.fontSize(12).fillColor('black').text(paragraph);
      doc.moveDown();
    });

    // Add a page break after each chapter, except the last one
    if (i < chapterKeys.length - 1) {
      doc.addPage();
    }
  }

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

app.post('/api/generate-story-from-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const imageFilePath = req.file.path;
  const numChapters = req.body.numChapters || 1; // Default to 3 chapters if not specified
  const maxWordsPerChapter = req.body.maxWordsPerChapter || 500; // Default to 500 words if not specified

  try {
    // Generate initial story description from image
    const initialDescription = await describeImage(imageFilePath);

    // Generate full story based on the description
    const storyPrompt = `Based on this description, create a ${numChapters}-chapter story: ${initialDescription}`;
    const storyData = await makeChatRequest(storyPrompt, numChapters, maxWordsPerChapter);

    // Generate a summary of the entire story
    const fullStory = Object.values(storyData).join('\n\n');
    const summary = await summarizeStory(fullStory);

    // Generate a name for the story
    const storyName = generateStoryName(summary);

    // Generate images for each chapter
    const imageUrls = await Promise.all(
      Object.keys(storyData)
        .filter(key => key.startsWith('chapter') && !key.endsWith('Name'))
        .map(async (chapterKey) => {
          const chapterSummary = await summarizeStory(storyData[chapterKey]);
          return generateImage(chapterSummary);
        })
    );

    res.json({ ...storyData, summary, imageUrls, storyName });
  } catch (error) {
    console.error('Error in generate-story-from-image:', error.message || error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    fs.unlinkSync(imageFilePath); // Delete the temporary image file
  }
});

app.post('/api/create-flipbook', async (req, res) => {
  const { storyData, imageUrls, storyName } = req.body;

  // Validate input data
  if (!storyData || !imageUrls || !storyName) {
    return res.status(400).json({ error: 'Missing required fields: storyData, imageUrls, storyName' });
  }

  try {
    // Create pages array for flipbook
    const pages = Object.keys(storyData)
      .filter(key => key.startsWith('chapter') && !key.endsWith('Name'))
      .map((chapterKey, index) => ({
        content: storyData[chapterKey],
        image: imageUrls[index]
      }));

    // Placeholder for the actual Flipbook API request
    const flipbookResponse = await axios.post('https://api.flipbook.com/create', {
      apiKey: flipbookApiKey,
      title: storyName,
      pages: pages
    });

    const flipbookUrl = flipbookResponse.data.url;

    res.json({ flipbookUrl });
  } catch (error) {
    console.error('Error creating flipbook:', error);
    res.status(500).json({ error: 'Failed to create flipbook', details: error.message });
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