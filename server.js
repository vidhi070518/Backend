const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const app = express();
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

const freeTierLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  message: {
    error: 'Free tier limit reached',
    message: 'You have used all 10 free verifications today. Upgrade to Pro for unlimited access.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests',
    message: 'Too many requests from this IP. Please wait 15 minutes and try again.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

const sanitizeText = (text) => {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[<>'"`;]/g, '')
    .replace(/\\/g, '')
    .replace(/(\r\n|\n|\r){3,}/g, '\n\n')
    .trim();
};

const verifyValidation = [
  body('text')
    .exists().withMessage('Text field is required')
    .isString().withMessage('Text must be a string')
    .isLength({ min: 10 }).withMessage('Text is too short. Please paste at least a sentence.')
    .isLength({ max: 10000 }).withMessage('Text is too long. Please keep it under 10000 characters.')
    .trim()
    .escape(),
];

app.get('/health', (req, res) => {
  res.json({ status: 'Factwise backend is running' });
});

// ─── Verify Route ─────────────────────────────────────────────────────────────
app.post('/api/verify', freeTierLimiter, verifyValidation, async (req, res) => {

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }

  const text = sanitizeText(req.body.text);
  const userId = req.body.userId || null;

  if (!text || text.length === 0) {
    return res.status(400).json({ error: 'Text became empty after sanitization. Please try again.' });
  }

  try {
    const response = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are a fact-checking assistant for Factwise. Your job is to analyze AI-generated text and verify its claims in plain English that anyone can understand — no technical jargon.

Analyze the following text and return a JSON response in exactly this format:
{
  "overall": "trusted" | "questionable" | "unreliable",
  "summary": "A 2-3 sentence plain English summary of your overall finding",
  "claims": [
    {
      "claim": "the specific claim extracted from the text",
      "status": "verified" | "questionable" | "incorrect",
      "explanation": "plain English explanation of why — max 2 sentences, no jargon"
    }
  ],
  "tip": "One practical tip for the user about this text"
}

Rules:
- Extract maximum 6 most important claims
- Write like you are explaining to a smart 16-year-old
- Never use words like hallucination, LLM, tokens, parameters
- Be direct and honest, not overly cautious
- Only return the JSON, nothing else

Text to analyze:
${text}`
        }
      ]
    });

    const rawContent = response.choices[0].message.content;

    let result;
    try {
      const cleaned = rawContent.replace(/```json|```/g, '').trim();
      result = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'Could not parse verification result. Please try again.' });
    }

    if (!result.overall || !result.summary || !result.claims || !result.tip) {
      return res.status(500).json({ error: 'Incomplete verification result. Please try again.' });
    }

    // ─── Save to Supabase if user is logged in ────────────────────────────────
    if (userId) {
      try {
        await supabase.from('verifications').insert({
          user_id: userId,
          input_text: text,
          overall: result.overall,
          summary: result.summary,
          claims: result.claims,
          tip: result.tip,
        });
      } catch (dbError) {
        console.error('DB save error:', dbError.message);
        // Don't fail the request if DB save fails
      }
    }

    res.json({ success: true, result });

  } catch (error) {
    console.error('Verification error:', error.message);
    res.status(500).json({ error: 'Verification failed. Please try again in a moment.' });
  }
});

// ─── Get verification history for a user ─────────────────────────────────────
app.get('/api/history/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: 'User ID required' });
  }

  try {
    const { data, error } = await supabase
      .from('verifications')
      .select('id, overall, summary, input_text, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    res.json({ success: true, history: data });
  } catch (error) {
    console.error('History error:', error.message);
    res.status(500).json({ error: 'Could not fetch history. Please try again.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Factwise backend running on port ${PORT}`);
});
