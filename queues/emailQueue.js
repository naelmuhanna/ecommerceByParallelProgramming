const EventEmitter = require('events');

class SimpleQueue extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.processing = false;
    this.handler = null;

    this.on('process', () => {
      this.drain();
    });
  }

  process(handler) {
    this.handler = handler;
    this.emit('process');
  }

  async add(nameOrData, maybeData) {
    const hasName = typeof nameOrData === 'string';
    const name = hasName ? nameOrData : 'default';
    const data = hasName ? maybeData : nameOrData;

    const job = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      data,
      attempts: 0,
    };

    this.jobs.push(job);
    this.emit('process');
    return job;
  }

  async drain() {
    if (this.processing) return;
    if (!this.handler) return;
    if (this.jobs.length === 0) return;

    this.processing = true;
    try {
      const job = this.jobs.shift();
      await this.runJob(job);
    } finally {
      this.processing = false;
      if (this.jobs.length > 0) {
        setImmediate(() => this.emit('process'));
      }
    }
  }

  async runJob(job) {
    const maxAttempts = 3;
    job.attempts += 1;

    try {
      await this.handler(job);
      this.emit('completed', job);
    } catch (err) {
      this.emit('failed', job, err);
      if (job.attempts < maxAttempts) {
        this.jobs.push(job);
        const delayMs = 5000 * job.attempts;
        setTimeout(() => this.emit('process'), delayMs);
      }
    }
  }
}


const emailQueue = new SimpleQueue();