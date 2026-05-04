FROM node:20-alpine

# Track the latest published @tensorfeed/mcp-server so introspection
# (Glama, smoke tests, etc.) always sees the current tool surface
# without us having to bump this pin every release.
RUN npm install -g @tensorfeed/mcp-server@latest

ENTRYPOINT ["tensorfeed-mcp"]
