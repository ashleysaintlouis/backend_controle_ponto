import dotenv from 'dotenv';

dotenv.config();

const app = require('./app').default as any;

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  console.log(`[server] Servidor rodando com sucesso na porta ${PORT}`);
});