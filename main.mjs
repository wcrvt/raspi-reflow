import board from './driver.mjs';

await board.setup();
board.reflow();


const wd = setInterval(() => {
  if(board.finish == true) {
    board.close();
    console.log('closed');
    clearInterval(wd);
  }
}, 5000);


//board.close();
