// Child-process fixture: keep protocol timestamps independent of the test execution date.
Date.now = () => Date.UTC(2030, 0, 2);
