import bunyan from 'bunyan'

const logger = bunyan.createLogger({
  name: 'imager'
})

export default logger
