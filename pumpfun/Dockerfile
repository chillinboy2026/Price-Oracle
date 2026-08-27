FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY scripts/ ./scripts/

# No secrets in the image: they arrive as PUMPBOT_* environment variables
# and the config is mounted as a volume.
ENV PYTHONUNBUFFERED=1
RUN mkdir -p /app/logs /app/state

CMD ["python", "-m", "src.pipeline", "--config", "/app/config/config.yaml"]
