FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=development
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "npm run build && if [ ! -f data/app.db ]; then npm run seed; fi && npm start"]
