const express = require('express')
const path = require('path')
const fs = require('fs')

const app = express()
const DATA_FILE = process.env.DATA_FILE || '/app/data/settings.json'

// Ensure data directory exists
const dataDir = path.dirname(DATA_FILE)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

app.use(express.json({ limit: '20mb' }))
app.use(express.static(path.join(__dirname, 'public')))

const SECRET_KEYS = ['anthropic_api_key', 'emailjs_public_key', 'emailjs_service_id', 'emailjs_template_id']

const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.0000008,  output: 0.000004  },
  'claude-sonnet-4-6':         { input: 0.000003,   output: 0.000015  },
  'claude-opus-4-6':           { input: 0.000015,   output: 0.000075  },
}

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }
  catch { return {} }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
}

function calcCost(model, input, output) {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-haiku-4-5-20251001']
  return input * p.input + output * p.output
}

// GET /api/settings — returns settings with secrets masked
app.get('/api/settings', (req, res) => {
  const data = loadData()
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === 'token_usage') continue
    if (SECRET_KEYS.includes(k)) {
      out[`has_${k}`] = !!v
    } else {
      out[k] = v
    }
  }
  res.json(out)
})

// PUT /api/settings — save a single key
app.put('/api/settings', (req, res) => {
  const { key, value } = req.body
  if (!key) return res.status(400).json({ error: 'key required' })
  const data = loadData()
  data[key] = value
  saveData(data)
  res.json({ ok: true })
})

// GET /api/config — public config for the frontend (EmailJS keys)
app.get('/api/config', (req, res) => {
  const data = loadData()
  res.json({
    emailjs_public_key:   data.emailjs_public_key   || '',
    emailjs_service_id:   data.emailjs_service_id   || '',
    emailjs_template_id:  data.emailjs_template_id  || '',
    ai_model:             data.ai_model              || 'claude-haiku-4-5-20251001',
  })
})

// GET /api/token-usage
app.get('/api/token-usage', (req, res) => {
  const data = loadData()
  const usage = data.token_usage || []
  const now = Date.now()

  function aggregate(entries) {
    const byModel = {}
    let input = 0, output = 0
    for (const e of entries) {
      input += e.input_tokens || 0
      output += e.output_tokens || 0
      const m = e.model || 'unknown'
      if (!byModel[m]) byModel[m] = { input: 0, output: 0 }
      byModel[m].input += e.input_tokens || 0
      byModel[m].output += e.output_tokens || 0
    }
    const cost = entries.reduce((sum, e) => sum + calcCost(e.model, e.input_tokens || 0, e.output_tokens || 0), 0)
    const models = Object.entries(byModel).map(([model, t]) => ({
      model,
      input: t.input,
      output: t.output,
      cost: calcCost(model, t.input, t.output),
    }))
    return { input, output, cost, models }
  }

  res.json({
    total:   aggregate(usage),
    last7d:  aggregate(usage.filter(e => e.timestamp >= now - 7  * 86400000)),
    last30d: aggregate(usage.filter(e => e.timestamp >= now - 30 * 86400000)),
  })
})

// POST /api/analyze — proxy to Anthropic, track token usage
app.post('/api/analyze', async (req, res) => {
  const data = loadData()
  const apiKey = data.anthropic_api_key
  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured. Ga naar /settings.' })

  const model = data.ai_model || 'claude-haiku-4-5-20251001'

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: req.body.system,
        messages: req.body.messages,
      }),
    })

    const result = await response.json()

    if (response.ok && result.usage) {
      data.token_usage = data.token_usage || []
      data.token_usage.push({
        timestamp: Date.now(),
        model,
        input_tokens:  result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
      })
      saveData(data)
    }

    res.status(response.status).json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/chat — AI receptie chat via Haiku
app.post('/api/chat', async (req, res) => {
  const data = loadData()
  const apiKey = data.anthropic_api_key
  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured' })

  const messages = req.body.messages || []
  const report = req.body.report || {}

  const reportContext = report.category
    ? `De gast heeft zojuist een melding gedaan: categorie "${report.category}", omschrijving: "${report.description}", urgentie: "${report.urgency}". Houd hier rekening mee in je antwoorden.`
    : ''

  const systemPrompt = `Je bent Daan, de vriendelijke receptie van vakantiepark Drentse Lagune. Je helpt gasten beknopt en behulpzaam met vragen over hun verblijf, de technische dienst en parkfaciliteiten. Antwoord altijd in de taal van de gast. Houd antwoorden kort (1-3 zinnen). ${reportContext}`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: systemPrompt,
        messages,
      }),
    })

    const result = await response.json()

    if (response.ok && result.usage) {
      data.token_usage = data.token_usage || []
      data.token_usage.push({
        timestamp: Date.now(),
        model: 'claude-haiku-4-5-20251001',
        input_tokens:  result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
      })
      saveData(data)
    }

    res.status(response.status).json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Serve settings page
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'))
})

app.listen(3000, () => console.log('SpotSolve listening on port 3000'))
