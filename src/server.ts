import http from 'http'
import express from 'express'
import fs from 'fs'
import helmet from 'helmet'
import logger from './lib/logger'
import * as identicon from './lib/identicon'
import { PORT, IDENTICON_CACHE_DIR } from './config'

if (!fs.existsSync(IDENTICON_CACHE_DIR)) {
  fs.mkdirSync(IDENTICON_CACHE_DIR)
}

const app = express()
app.use(helmet())

app.get('/', (req, res) => {
  res.status(200).send('identicon')
})

app.get('/api/identicon/:id', (req, res) => {
  identicon
    .generate(req.params.id, 150)
    .then(data => {
      res.contentType('image/png')
      res.send(data)
    })
    .catch(err => {
      logger.error('[identicon]', err)
      res.status(500).send('Internal Server Error')
    })
})

app.use((err, _req, res, _next) => {
  res.status(500).send('Internal Server Error')
  logger.error('[Internal Server Error]', err)
})

const server = http.createServer(app)

server.listen(PORT, () => {
  logger.info('Listening on', server.address())
})

const timeout = 40 * 1000
process.on('SIGTERM', () => {
  logger.info('Server terminating')
  server.close(() => {
    logger.info('Server terminated')
  })

  const timer = setTimeout(() => {
    logger.info('timeout: Server terminated')
    process.exit(1)
  }, timeout)
  timer.unref()
})
