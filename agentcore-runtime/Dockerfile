# AgentCore Runtime requires arm64 architecture
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy main application
COPY main.py .

# AgentCore Runtime uses port 8080
EXPOSE 8080

# Run the AgentCore application
CMD ["python", "main.py"]
