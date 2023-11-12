FROM node:lts-alpine

# Set the working directory to /app
WORKDIR /app

# Copy the package.json and package-lock.json files to the container
COPY package*.json ./

# Install the dependencies
RUN npm install

# Copy the rest of the application code to the container
COPY . .

RUN npm run build

# Expose port 8080
EXPOSE 8080

# Start the Express server
CMD ["node", "dist/startServer.js"]
