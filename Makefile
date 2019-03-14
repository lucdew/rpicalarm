.DEFAULT_GOAL := cleaninstall
.PHONY: clean install cleaninstall

PIP             := pip

clean:
	sudo rm -rf build dist rpicalarm.egg-info
	find . -name '*.pyc' -name '*.pyo' -o -name '*.pyc' -exec rm -f {} \;

#test:
#	$(PYTEST) -v

install:
	@echo "Installing rpicalarm"
	sudo python3 setup.py clean install

cleaninstall: clean install
