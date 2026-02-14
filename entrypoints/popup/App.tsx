import { useState } from 'react';
import { Button } from '@/components/ui/button';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-w-[320px] p-6 text-center">
      <h1 className="text-2xl font-bold mb-4">CalgaryHacks</h1>
      <div className="mb-4">
        <Button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Chrome Extension powered by WXT + React
      </p>
    </div>
  );
}

export default App;
