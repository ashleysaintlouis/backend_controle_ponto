import dotenv from 'dotenv';

dotenv.config();

const app = require('./app').default as any;

const port = process.env.PORT || 3333;

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});