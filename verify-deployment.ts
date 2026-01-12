const RENDER_URL = "https://purple-box.onrender.com";

/**
 * Verify deployment script
 * Checks if the Render deployment is online and responding
 */
async function verifyDeployment() {
  try {
    console.log(`\n🔍 Checking deployment at: ${RENDER_URL}\n`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(RENDER_URL, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Log status code
    console.log(`📊 Status Code: ${response.status}`);

    // Log response body
    const responseBody = await response.text();
    console.log(`📄 Response Body:`, responseBody);

    // Check if status is 200
    if (response.status === 200) {
      const green = '\x1b[32m';
      const reset = '\x1b[0m';
      const bold = '\x1b[1m';
      console.log('\n');
      console.log(`${green}${bold}${'✅'.repeat(20)}${reset}`);
      console.log(`${green}${bold}${'✅'.repeat(20)}${reset}`);
      console.log(`${green}${bold}   ✅ SYSTEM ONLINE ✅${reset}`);
      console.log(`${green}${bold}${'✅'.repeat(20)}${reset}`);
      console.log(`${green}${bold}${'✅'.repeat(20)}${reset}`);
      console.log('\n');
      process.exit(0);
    } else {
      console.error(`\n❌ Deployment returned status ${response.status} (expected 200)\n`);
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        console.error('\n❌ Request timed out after 10 seconds\n');
      } else {
        console.error('\n❌ Error details:', error.message);
        console.error('Full error:', error);
      }
    } else {
      console.error('\n❌ Unknown error occurred:', error);
    }
    process.exit(1);
  }
}

// Run the verification and handle unhandled promise rejections
verifyDeployment().catch((error) => {
  console.error('\n❌ Unhandled error:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('\n❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
