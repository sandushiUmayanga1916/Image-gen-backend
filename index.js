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
const https = require('https');
const sizeOf = require('image-size');
const { PassThrough } = require('stream');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');

const app = express();
const port = 4000;
const router = express.Router();
const MAX_RETRIES = 5;

const pdfPreviews = new Map();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Start the server and print the URLs
app.listen(port, () => {
  console.log(`API listening on PORT ${port} `)
})

app.use(cors());
app.use(bodyParser.json());
dotenv.config();


const apiKey = process.env.API_KEY;
const openai = new OpenAI({ apiKey });

const FLIPBOOK_API_URL = 'https://api-tc.is.flippingbook.com/api/v1/fbonline/publication/';
const FLIPBOOK_API_KEY = process.env.FLIPBOOK_API;

const validateInput = [
  body('storyData').isObject().notEmpty(),
  body('imageUrls').isArray().notEmpty(),
  body('storyName').isString().notEmpty().trim()
];

const makeRequestWithRetry = async (url, data, options, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios.post(url, data, options);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
};



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
      size: "1024x1024",  // Ensure this size is valid
      response_format: "url"
    });

    return response.data[0].url; // Confirm this path based on actual API response
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

app.post('/api/generate-pdf-preview', async (req, res) => {
  const { storyData, imageUrls, storyName } = req.body;

  if (!storyData || !storyName) {
    return res.status(400).json({ error: 'Story content and name are required' });
  }

  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const previewId = uuidv4();
    const pdfPath = path.join(__dirname, 'pdf-previews', `${previewId}.pdf`);
    
    // Ensure the pdf-previews directory exists
    if (!fs.existsSync(path.join(__dirname, 'pdf-previews'))) {
      fs.mkdirSync(path.join(__dirname, 'pdf-previews'));
    }

    // Generate PDF content
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#333333').text(storyName, { align: 'center' });
    doc.moveDown(2);

    const chapterKeys = Object.keys(storyData).filter(key => key.startsWith('chapter') && !key.endsWith('Name'));

    for (let i = 0; i < chapterKeys.length; i++) {
      const chapterKey = chapterKeys[i];
      const chapterNameKey = `${chapterKey}Name`;
      const chapterContent = storyData[chapterKey];
      const chapterName = storyData[chapterNameKey];
      const imageUrl = imageUrls[i];

      doc.fontSize(18).font('Helvetica-Bold').fillColor('#0066cc')
         .text(`Chapter ${i + 1}: ${chapterName}`, { align: 'left' });
      doc.moveDown();

      doc.fontSize(12).font('Helvetica').fillColor('#000000');
      const paragraphs = chapterContent.split('\n\n');
      paragraphs.forEach(paragraph => {
        doc.text(paragraph, {
          align: 'justify',
          lineGap: 5
        });
        doc.moveDown();
      });

      if (imageUrl) {
        try {
          const imageBuffer = await downloadImageToBuffer(imageUrl);
          if (imageBuffer && imageBuffer.length > 0) {
            const dimensions = sizeOf(imageBuffer);
            const imgWidth = 400;
            const imgHeight = (dimensions.height / dimensions.width) * imgWidth;
            
            doc.image(imageBuffer, {
              fit: [imgWidth, imgHeight],
              align: 'center',
              valign: 'center'
            });
          }
        } catch (imgError) {
          console.error('Error adding image to PDF:', imgError.message || imgError);
        }
      }

      if (i < chapterKeys.length - 1) {
        doc.addPage();
      }
    }

    // Save the PDF to a file
    const writeStream = fs.createWriteStream(pdfPath);
    doc.pipe(writeStream);
    doc.end();

    writeStream.on('finish', () => {
      // Store the PDF path for later retrieval
      pdfPreviews.set(previewId, pdfPath);
      // Generate the preview URL
      const previewUrl = `http://localhost:${port}/api/pdf-preview/${previewId}`;
      // Return the preview ID and URL to the client
      res.json({ previewId, previewUrl });
    });
  } catch (error) {
    console.error('Error generating PDF preview:', error);
    res.status(500).json({ error: 'An error occurred while generating the PDF preview.' });
  }
});
// Endpoint to serve the PDF preview
app.get('/api/pdf-preview/:previewId', (req, res) => {
  const { previewId } = req.params;
  const pdfPath = pdfPreviews.get(previewId);

  if (!pdfPath) {
    return res.status(404).json({ error: 'PDF preview not found' });
  }

  res.sendFile(pdfPath);
});

// Cleanup mechanism to remove old previews
const cleanupPreviews = () => {
  const now = Date.now();
  pdfPreviews.forEach((path, id) => {
    if (now - fs.statSync(path).mtimeMs > 3600000) { // Remove after 1 hour
      fs.unlinkSync(path);
      pdfPreviews.delete(id);
    }
  });
};

setInterval(cleanupPreviews, 3600000); // Run cleanup every hour

// Helper function to download image to a buffer
const downloadImageToBuffer = async (url) => {
  try {
    const response = await axios({ url, responseType: 'arraybuffer' });
    if (response.status !== 200) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    return Buffer.from(response.data, 'binary');
  } catch (error) {
    console.error('Error downloading image:', error.message || error);
    throw error; 
  }
};


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
  const numChapters = req.body.numChapters || 1;
  const maxWordsPerChapter = req.body.maxWordsPerChapter || 500;

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
    const chapterKeys = Object.keys(storyData).filter(key => key.startsWith('chapter') && !key.endsWith('Name'));
    const imageUrls = await Promise.all(
      chapterKeys.map(async (chapterKey) => {
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

app.post('/api/generate-pdf', async (req, res) => {
  const { storyData, imageUrls, storyName } = req.body;

  if (!storyData || !imageUrls) {
    return res.status(400).json({ error: 'Story content and images are required' });
  }

  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = new PassThrough();

    // Pipe the document to a writable stream
    doc.pipe(stream);

    // Add story name
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#333333').text(storyName, { align: 'center' });
    doc.moveDown(2);

    const chapterKeys = Object.keys(storyData).filter(key => key.startsWith('chapter') && !key.endsWith('Name'));

    for (let i = 0; i < chapterKeys.length; i++) {
      const chapterKey = chapterKeys[i];
      const chapterNameKey = `${chapterKey}Name`;
      const chapterContent = storyData[chapterKey];
      const chapterName = storyData[chapterNameKey];
      const imageUrl = imageUrls[i];

      // Add chapter name
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#0066cc')
         .text(`Chapter ${i + 1}: ${chapterName}`, { align: 'left' });
      doc.moveDown();

      // Add chapter content
      doc.fontSize(12).font('Helvetica').fillColor('#000000');
      const paragraphs = chapterContent.split('\n\n');
      paragraphs.forEach(paragraph => {
        doc.text(paragraph, {
          align: 'justify',
          lineGap: 5
        });
        doc.moveDown();
      });

      // Add a page break for the image
      doc.addPage();

      // Add chapter image
      if (imageUrl) {
        try {
          const imageBuffer = await downloadImageToBuffer(imageUrl);
          if (!imageBuffer || imageBuffer.length === 0) {
            throw new Error('Image buffer is empty');
          }
          const dimensions = sizeOf(imageBuffer);
          const imgWidth = 400;
          const imgHeight = (dimensions.height / dimensions.width) * imgWidth;
          
          doc.image(imageBuffer, {
            fit: [imgWidth, imgHeight],
            align: 'center',
            valign: 'center'
          });
          doc.moveDown();
        } catch (imgError) {
          console.error('Error adding image to PDF:', imgError.message || imgError);
          doc.fontSize(10).fillColor('#ff0000').text('Error loading image', { align: 'center' });
          doc.moveDown();
        }
      }

      // Add a page break after each chapter, except the last one
      if (i < chapterKeys.length - 1) {
        doc.addPage();
      }
    }

    doc.end();

    stream.on('data', chunk => res.write(chunk));
    stream.on('end', () => res.end());

  } catch (error) {
    console.error('Error generating PDF:', error.message || error);
    res.status(500).json({ error: 'An error occurred while generating the PDF.' });
  }
});



const getPublicationDetails = async (flipbookId, retries = 3) => {
  try {
    const response = await axios.get(`${FLIPBOOK_API_URL}${flipbookId}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${FLIPBOOK_API_KEY}`
      }
    });
    return response.data;
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying to get publication details. Attempts left: ${retries - 1}`);
      await delay(2000 * (4 - retries)); // Exponential backoff
      return getPublicationDetails(flipbookId, retries - 1);
    }
    throw error;
  }
};

app.post('/api/create-flipbook-from-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  try {
    const pdfPath = req.file.path;
    const pdfFileName = req.file.originalname;

    // Read the PDF file
    const pdfData = fs.readFileSync(pdfPath);

    // Create a FormData object to send the PDF file
    const formData = new FormData();
    formData.append('file', new Blob([pdfData], { type: 'application/pdf' }), pdfFileName);

    // Create the flipbook
    const createResponse = await axios.post(`${FLIPBOOK_API_URL}create`, formData, {
      headers: {
        ...formData.getHeaders(),
        'Accept': 'application/json',
        'Authorization': `Bearer ${FLIPBOOK_API_KEY}`
      }
    });

    console.log('FlippingBook API Response:', createResponse.data);

    if (createResponse.data && createResponse.data.id) {
      const flipbookId = createResponse.data.id;

      // Wait for the flipbook to be processed
      let flipbookUrl = null;
      let attempts = 0;
      while (!flipbookUrl && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between checks
        const statusResponse = await axios.get(`${FLIPBOOK_API_URL}${flipbookId}`, {
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${FLIPBOOK_API_KEY}`
          }
        });

        if (statusResponse.data.publication && statusResponse.data.publication.state === 'Ready') {
          flipbookUrl = `https://online.flippingbook.com/view/${statusResponse.data.publication.hashId}/`;
          break;
        }

        attempts++;
      }

      if (flipbookUrl) {
        res.json({ success: true, flipbookUrl: flipbookUrl });
      } else {
        throw new Error('Flipbook processing timed out');
      }
    } else {
      throw new Error('Invalid or unexpected response from FlippingBook API');
    }
  } catch (error) {
    console.error('Error creating flipbook:', error.message);
    if (error.response) {
      console.error('FlippingBook API error response:', error.response.data);
    }
    res.status(500).json({ 
      error: 'An error occurred while creating the flipbook',
      details: error.message,
      responseData: error.response ? error.response.data : null
    });
  } finally {
    // Clean up the uploaded file
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
  }
});

app.post('/api/create-flipbook-from-url', async (req, res) => {
  const { previewUrl } = req.body;

  if (!previewUrl) {
    return res.status(400).json({ error: 'Preview URL is required' });
  }

  try {
    console.log(`Attempting to download PDF from: ${previewUrl}`);
    const pdfResponse = await axios.get(previewUrl, { responseType: 'arraybuffer' });
    const pdfBuffer = Buffer.from(pdfResponse.data);

    // Save the PDF to a temporary file
    const tempFilePath = path.join(__dirname, 'temp', `temp-${Date.now()}.pdf`);
    fs.writeFileSync(tempFilePath, pdfBuffer);

    console.log(`Temporary PDF saved to: ${tempFilePath}`);

    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempFilePath), {
      filename: 'story.pdf',
      contentType: 'application/pdf',
    });

    console.log('Sending request to FlippingBook API...');
    const createResponse = await axios.post(`${FLIPBOOK_API_URL}create`, formData, {
      headers: {
        ...formData.getHeaders(),
        'Accept': 'application/json',
        'Authorization': `Bearer ${FLIPBOOK_API_KEY}`
      }
    });

    console.log('FlippingBook API Response:', createResponse.data);

    if (createResponse.data && createResponse.data.id) {
      const flipbookId = createResponse.data.id;
      let flipbookUrl = null;
      let attempts = 0;

      while (!flipbookUrl && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const statusResponse = await axios.get(`${FLIPBOOK_API_URL}${flipbookId}`, {
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${FLIPBOOK_API_KEY}`
          }
        });

        console.log(`Attempt ${attempts + 1}: Flipbook status:`, statusResponse.data.publication.state);

        if (statusResponse.data.publication && statusResponse.data.publication.state === 'Ready') {
          flipbookUrl = `https://online.flippingbook.com/view/${statusResponse.data.publication.hashId}/`;
          break;
        }

        attempts++;
      }

      if (flipbookUrl) {
        res.json({ success: true, flipbookUrl: flipbookUrl });
      } else {
        throw new Error('Flipbook processing timed out');
      }
    } else {
      throw new Error('Invalid or unexpected response from FlippingBook API');
    }
  } catch (error) {
    console.error('Error creating flipbook:', error.message);
    if (error.response) {
      console.error('FlippingBook API error response:', error.response.data);
    }
    res.status(500).json({ 
      error: 'An error occurred while creating the flipbook',
      details: error.message,
      responseData: error.response ? error.response.data : null
    });
  } finally {
    // Clean up the temporary file
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
});


const checkFlipbookStatus = async (flipbookId) => {
  try {
    const publicationDetails = await getPublicationDetails(flipbookId);
    const status = publicationDetails?.publication?.state || 'Unknown';
    console.log(`Flipbook ${flipbookId} status: ${status}`);

    // If status is not 'Ready', schedule another check after 30 seconds
    if (status !== 'Ready') {
      setTimeout(() => checkFlipbookStatus(flipbookId), 30000);
    }
  } catch (error) {
    console.error(`Error checking status for flipbook ${flipbookId}:`, error.message);
  }
};

// Endpoint to check flipbook status
app.get('/api/check-flipbook-status/:flipbookId', async (req, res) => {
  const flipbookId = req.params.flipbookId;
  try {
    const publicationDetails = await getPublicationDetails(flipbookId);
    const status = publicationDetails?.publication?.state || 'Unknown';
    res.json({ status, details: publicationDetails });
  } catch (error) {
    console.error('Error checking flipbook status:', error);
    res.status(500).json({ error: 'Failed to check flipbook status' });
  }
});

// Serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/view-flipbook/:hashId', (req, res) => {
  const hashId = req.params.hashId;
  const flipbookUrl = `https://online.flippingbook.com/view/${hashId}/`;
  res.redirect(flipbookUrl);
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


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