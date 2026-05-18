const autocannon = require('autocannon');

function startCashOrderLoadTest() {
  let printed = 0;
  const instance = autocannon({
    url: `http://localhost:8000/api/v1/orders/6a09e2213c667351ee87f3ea`, 
    connections: 15, 
    duration: 10,    
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2YTA5YjgzMjY5ZGQyZDVlZjI0ODU3MmMiLCJpYXQiOjE3NzkwMjE5MjQsImV4cCI6MTc3OTYyNjcyNH0.cmBnTXu70F1HhkTVGDAUa-A2H3XTZT5lPygkr3GXilk'
    },
    body: JSON.stringify({
      shippingAddress: {
        details: "123 Main Street, Apt 4B",
        phone: "0943925060",
        city: "Damascus",
        postalCode: "11122"
      }
    }),
    setupClient: (client) => {
      let lastStatusCode;
      client.on('response', (statusCode) => {
        lastStatusCode = statusCode;
      });
      client.on('body', (body) => {
        if (printed >= 5) return;
        if (lastStatusCode && (lastStatusCode < 200 || lastStatusCode >= 300)) {
          printed += 1;
          try {
            console.error(`Non-2xx response body (status ${lastStatusCode}):`);
            console.error(body.toString());
          } catch (err) {
            console.error(`Non-2xx response body (status ${lastStatusCode}): [unprintable]`);
          }
        }
      });
    },
  }, (err, result) => {
    if (err) {
      console.error("Error during test execution:", err);
    } else {
      console.log("Test completed safely!");
    }
  });

  autocannon.track(instance, { renderProgressBar: true });
}


startCashOrderLoadTest();