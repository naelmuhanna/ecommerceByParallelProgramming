const autocannon = require('autocannon');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// 1. Create and populate the multipart form payload
const form = new FormData();
form.append('title', 'Load Test Product');
form.append('description', 'This is a description long enough to pass validation.');
form.append('quantity', '50');
form.append('price', '120');

// !!! REPLACE THIS ID WITH A REAL CATEGORY ID FROM YOUR MONGODB !!!
form.append('category', '6a09bbc5baa29bedcdc6c8f2');

// Attach your local test image (use Buffer so autocannon can reuse the same body safely)
const imagePath = path.join(
  __dirname,
  'product-efe3b800-b600-48af-b132-c97ef1d40f88-1642637711473-2.jpeg'
);
const imageBuffer = fs.readFileSync(imagePath);
form.append('imageCover', imageBuffer, {
  filename:
    'product-efe3b800-b600-48af-b132-c97ef1d40f88-1642637711473-2.jpeg',
  contentType: 'image/jpeg',
});

// 2. Define the security token
const authToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2YTA5YjgzMjY5ZGQyZDVlZjI0ODU3MmMiLCJpYXQiOjE3NzkwMjE5MjQsImV4cCI6MTc3OTYyNjcyNH0.cmBnTXu70F1HhkTVGDAUa-A2H3XTZT5lPygkr3GXilk';

const bodyBuffer = form.getBuffer();
const headers = {
  Authorization: authToken,
  ...form.getHeaders(),
  'Content-Length': bodyBuffer.length,
};

// 3. Start the load test instance
const instance = autocannon({
  url: 'http://localhost:8000/api/v1/products',
  connections: 5,     // Kept relatively low to prevent crashing your system
  duration: 15,       // Runs test for 15 seconds
  method: 'POST',
  headers,
  body: bodyBuffer,
}, (err, result) => {
  if (err) {
    console.error('Test ran into an error:', err);
  } else {
    console.log('Test completed safely!');
  }
});

// Track responses in the terminal console output as they stream

autocannon.track(instance, { renderProgressBar: true });