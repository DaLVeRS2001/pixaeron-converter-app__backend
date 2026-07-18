import axios from 'axios';

describe('GET /auth/health', () => {
  it('reports that the application and database are healthy', async () => {
    const res = await axios.get('/auth/health');

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'ok' });
  });
});
