FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data VIPS_CONCURRENCY=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home vectorio && mkdir /data && chown vectorio:vectorio /data
COPY backend ./backend
COPY frontend ./frontend
USER vectorio
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]

FROM runtime AS test
USER root
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt && mkdir -p /app/.tmp && chown vectorio:vectorio /app/.tmp
COPY tests ./tests
USER vectorio
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"]

# Plain `docker build .` also produces the application, not the test runner.
FROM runtime AS production
