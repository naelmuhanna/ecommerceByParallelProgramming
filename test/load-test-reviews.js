const autocannon = require('autocannon');

function startReviewsLoadTest() {
  const instance = autocannon({
    url: 'http://localhost:8000/api/v1/reviews',
    connections: 15, 
    duration: 10,   
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2YTA5YjgzMjY5ZGQyZDVlZjI0ODU3MmMiLCJpYXQiOjE3NzkwMjE5MjQsImV4cCI6MTc3OTYyNjcyNH0.cmBnTXu70F1HhkTVGDAUa-A2H3XTZT5lPygkr3GXilk'
    },
    requests: [
      {
        method: 'POST',
        setupRequest: (request) => {
          const randomRating = Math.floor(Math.random() * 5) + 1;
          
          request.body = JSON.stringify({
            title: `new review ${randomRating}`,
            ratings: randomRating,
            product: '6a09b6aa2cf95c7512b63dae' 
          });
          
          return request;
        }
      }
    ]
  }, (err, result) => {
    if (err) {
      console.error("Error during test execution:", err);
    } else {
      console.log("Test completed safely!");
    }
  });

  autocannon.track(instance, { renderProgressBar: true });
}


startReviewsLoadTest();