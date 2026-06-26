# Use the official Node.js image.
# https://hub.docker.com/_/node
# Pinned: node 22.23.0 (pulled by an unpinned `node:22` rebuild on 2026-06-22)
# ships an undici that throws "Premature close" on api.anthropic.com keep-alive
# connections, breaking all Claude calls (scoring/ranking/X-posts). 22.22.3 is
# the last known-good (revision vault-4-00105). Do NOT loosen back to `node:22`.
FROM --platform=linux/amd64 node:22.22.3

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
COPY package*.json ./

# Install all dependencies (ts-node needed at runtime since we run TypeScript directly).
RUN npm install

# Copy local code to the container image.
COPY . .

# Set the PORT environment variable
ENV PORT=8080

# Expose the port the app runs on
EXPOSE 8080

# Run the web service on container startup.
CMD [ "npm", "start" ]
