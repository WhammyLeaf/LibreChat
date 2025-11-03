const axios = require('axios');
const { logAxiosError } = require('@librechat/api');
const { EModelEndpoint } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');

/**
 * @typedef {Object} RetrieveOptions
 * @property {string} thread_id - The ID of the thread to retrieve.
 * @property {string} run_id - The ID of the run to retrieve.
 * @property {number} [timeout] - Optional timeout for the API call.
 * @property {number} [maxRetries] -  TODO: not yet implemented; Optional maximum number of retries for the API call.
 * @property {OpenAIClient} openai - Configuration and credentials for OpenAI API access.
 */

/**
 * Asynchronously retrieves data from an API endpoint based on provided thread and run IDs.
 *
 * @param {RetrieveOptions} options - The options for the retrieve operation.
 * @returns {Promise<Object>} The data retrieved from the API.
 */
async function retrieveRun({ thread_id, run_id, timeout, openai }) {
  logger.info(`[retrieveRun] Called for thread_id=${thread_id}, run_id=${run_id}, timeout=${timeout}`);
  logger.debug(`[retrieveRun] Using baseURL=${baseURL}`);
  logger.debug(`[retrieveRun] Request headers:`, headers);
  logger.debug(`[retrieveRun] Final URL: ${url}`);
  const appConfig = openai.req.config;
  const { apiKey, baseURL, httpAgent, organization } = openai;
  let url = `${baseURL}/threads/${thread_id}/runs/${run_id}`;

  let headers = {
    Authorization: `Bearer ${apiKey}`,
    'OpenAI-Beta': 'assistants=v1',
  };

  if (organization) {
    headers['OpenAI-Organization'] = organization;
  }

  /** @type {TAzureConfig | undefined} */
  const azureConfig = appConfig.endpoints?.[EModelEndpoint.azureOpenAI];

  if (azureConfig && azureConfig.assistants) {
    delete headers.Authorization;
    headers = { ...headers, ...openai._options.defaultHeaders };
    const queryParams = new URLSearchParams(openai._options.defaultQuery).toString();
    url = `${url}?${queryParams}`;
  }

  try {
    const axiosConfig = {
      headers: headers,
      timeout: timeout,
    };

    if (httpAgent) {
      axiosConfig.httpAgent = httpAgent;
      axiosConfig.httpsAgent = httpAgent;
    }

    logger.info(`[retrieveRun] Sending GET request to ${url}`);
    const response = await axios.get(url, axiosConfig);
    logger.info(`[retrieveRun] Received response for run_id=${run_id}, status=${response.status}`);
    return response.data;
  } catch (error) {
    logger.error(`[retrieveRun] Error retrieving run_id=${run_id}:`, error);
    const message = '[retrieveRun] Failed to retrieve run data:';
    throw new Error(logAxiosError({ message, error }));
  }
}

module.exports = { retrieveRun };
